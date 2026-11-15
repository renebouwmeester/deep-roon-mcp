/**
 * ObjectGraph — generic deserializer for the server's object stream.
 *
 * Ingests DEFTYPE (typeId -> name + ordered members[name, PropertyType]) and
 * PUSHOBJ/PUSHSTUB/UPDATEOBJ (oid + typeId + field values). Because DEFTYPE
 * supplies each member's PropertyType, we can deserialize every pushed object
 * generically — no need for a pre-registered local type.
 *
 * Ported from RemotingClientV2.OnPushObj/OnPushStub/OnUpdateObj,
 * TypeMappingHelper.DefineType, and PropertyMapping.Skip.
 */
import { Frame } from './frame';
import { BinaryReader } from './reader';

export enum PropertyType {
  Int, Long, Bool, Guid, Sooid, Double, Float, Char, DateTime, Enum,
  NullableInt, NullableLong, NullableBool, NullableGuid, NullableSooid,
  NullableDouble, NullableFloat, NullableChar, NullableDateTime, NullableEnum,
  String, ByteArray, Message, Object, LengthPrefixed,
}

export interface TypeMember {
  name: string;
  propType: PropertyType;
}
export interface TypeDef {
  id: number;
  name: string;
  members: TypeMember[];
}

/** A reference to another object by id (Object-typed members). */
export interface ObjRef {
  $ref: bigint;
}
export function isRef(v: unknown): v is ObjRef {
  return typeof v === 'object' && v !== null && '$ref' in (v as object);
}

/** Collection types supported by the object stream decoder. */
export function isCollectionType(typeName: string): boolean {
  return /(^|\.)(DataList|Query|VirtualQuery)</.test(typeName) || /\.Query$/.test(typeName);
}

export interface RoonObject {
  oid: bigint;
  typeId: number;
  typeName: string;
  fields: Record<string, unknown>;
}

export class ObjectGraph {
  readonly types = new Map<number, TypeDef>();
  readonly objects = new Map<string, RoonObject>(); // key = oid.toString()

  /** Feed one inbound server frame. Returns true if it was an object/type frame. */
  ingest(frame: Frame): boolean {
    if (frame.isResponse) return false;
    const r = new BinaryReader(Uint8Array.from(frame.body));
    switch (frame.cmd) {
      case 7: this.defineType(r); return true;   // DEFTYPE
      case 3: this.pushObj(r, true); return true; // PUSHOBJ (populate)
      case 4: this.pushObj(r, false); return true; // PUSHSTUB (no fields)
      case 5: this.pushObj(r, true); return true; // UPDATEOBJ (re-populate)
      default: return false;
    }
  }

  private defineType(r: BinaryReader): void {
    const id = r.flexInt();
    const name = r.string() ?? '';
    const count = r.flexInt();
    // Every member takes at least two bytes: a count beyond what's left is a malformed frame, not a type (15 Nov 2026).
    if (count > r.remaining / 2) throw new RangeError(`malformed frame: type ${name} claims ${count} members, ${r.remaining} bytes left`);
    const members: TypeMember[] = [];
    for (let i = 0; i < count; i++) {
      const mname = r.string() ?? '';
      const propType = r.integer() as PropertyType;
      members.push({ name: mname, propType });
    }
    this.types.set(id, { id, name, members });
  }

  private pushObj(r: BinaryReader, populate: boolean): void {
    const oid = r.flexLong();
    const typeId = r.flexInt();
    const def = this.types.get(typeId);
    const typeName = def?.name ?? `#${typeId}`;
    const fields: Record<string, unknown> = {};
    if (populate && def) {
      const dataList = /(?:^|\.)DataList<(.+)>$/.exec(typeName);
      if (dataList) {
        // Generated DataList<T>_Proxy.Populate reads count directly, then T
        // values; it replaces the backing list on BOTH PUSHOBJ and UPDATEOBJ.
        // Query<T>'s sparse (1,count,0) header below is a different codec.
        const primitives: Record<string, PropertyType> = {
          string: PropertyType.String, int: PropertyType.Int, long: PropertyType.Long,
          double: PropertyType.Double, float: PropertyType.Float, 'System.DateTime': PropertyType.DateTime,
        };
        // These DataList enum adapters use ReadInteger in the installed API.
        const integerEnums = ['DsdStrategy', 'MediaSource', 'TidalStreamFormat',
          'QobuzStreamFormat', 'KKBoxStreamFormat', 'NugsStreamFormat'];
        const elementType = dataList[1];
        const elementCodec = primitives[elementType] ??
          (integerEnums.some((name) => elementType === `Sooloos.Broker.Api.${name}` ||
            elementType === `Roon.Broker.Api.${name}`) ? PropertyType.Int : PropertyType.Object);
        const count = r.integer();
        const items: unknown[] = [];
        for (let i = 0; i < count && r.remaining > 0; i++) {
          try {
            const item = this.readValue(r, elementCodec);
            if (r.remaining < 0) break; // Do not invent a ref from a truncated varint.
            items.push(item);
          } catch {
            break;
          }
        }
        // Preserve an incomplete count so callers cannot mistake truncation for
        // a complete empty result. A later full UPDATEOBJ can replace it.
        fields.$count = r.pos > r.buf.length && items.length === count ? -1 : count;
        fields.$items = items;
      } else if (isCollectionType(typeName)) {
        // Query<T>: a built-in count property at
        // wire-index 1 (DEFTYPE declares no members), 0 terminates, then
        // `count` items (each via the Object/GetObject encoding).
        let count = 0;
        for (;;) {
          const idx = r.flexInt();
          if (idx === 0) break;
          if (idx === 1) count = r.integer();
          else break; // unknown collection property
        }
        // Items follow inline only when the body still has bytes; some pushes
        // send the count with items deferred (pushed separately by oid). Bound
        // the read to the actual buffer to avoid phantom items.
        const items: unknown[] = [];
        for (let i = 0; i < count && r.pos < r.buf.length; i++) {
          try {
            items.push(this.readValue(r, PropertyType.Object));
          } catch {
            break;
          }
        }
        fields.$count = count;
        fields.$items = items;
      } else {
        // Sparse field encoding: idx = flexInt (1-based member index; 0
        // terminates), then value, per the member's PropertyType.
        for (;;) {
          const idx = r.flexInt();
          if (idx === 0) break;
          const member = def.members[idx - 1];
          if (!member) break; // unknown index — can't advance; stop
          try {
            fields[member.name] = this.readValue(r, member.propType);
          } catch {
            break;
          }
        }
      }
    }
    const key = oid.toString();
    const existing = this.objects.get(key);
    if (existing) {
      // PUSHSTUB adds a reference; it does not erase an already loaded object.
      if (populate) Object.assign(existing.fields, fields);
    } else {
      this.objects.set(key, { oid, typeId, typeName, fields });
    }
  }

  /** Read one member value per its PropertyType (ported from PropertyMapping). */
  private readValue(r: BinaryReader, t: PropertyType): unknown {
    switch (t) {
      case PropertyType.Int: return r.integer();
      case PropertyType.Long: return r.long();
      case PropertyType.Bool: return r.boolean();
      case PropertyType.Guid: return r.guid();
      case PropertyType.Sooid: return r.sooid();
      case PropertyType.Double: return r.double();
      case PropertyType.Float: return r.float();
      case PropertyType.Char: return r.char();
      case PropertyType.DateTime: return r.dateTime();
      case PropertyType.Enum: return r.integer();
      case PropertyType.NullableInt: return r.optionalInteger();
      case PropertyType.NullableLong: return r.optionalLong();
      case PropertyType.NullableBool: return r.optionalBoolean();
      case PropertyType.NullableGuid: return r.optionalGuid();
      case PropertyType.NullableSooid: return r.optionalSooid();
      case PropertyType.NullableDouble: return r.optionalDouble();
      case PropertyType.NullableFloat: return r.optionalFloat();
      case PropertyType.NullableChar: return r.optionalChar();
      case PropertyType.NullableDateTime: return r.optionalDateTime();
      case PropertyType.NullableEnum: return r.optionalInteger();
      case PropertyType.String: return r.string();
      case PropertyType.ByteArray: return r.byteArray();
      case PropertyType.Message: return r.byteArray();
      case PropertyType.Object: {
        const marker = r.long();
        if (marker === 1n) {
          // inline value object: typeId, len, then len bytes of sparse field data
          const tid = r.integer();
          const len = r.integer();
          const sub = new BinaryReader(r.bytes(len));
          const def = this.types.get(tid);
          if (!def) return { $inline: tid };
          // Changed (3 Oct 2026): a DataList<T> by value — AlbumLite.Labels, .Genres — has no members but a count and
          // then the values, as with PUSHOBJ. Without this it came back empty ({$type} with nothing in it).
          const lijst = /(?:^|\.)DataList<(.+)>$/.exec(def.name);
          if (lijst) {
            const codec: Record<string, PropertyType> = { string: PropertyType.String, int: PropertyType.Int, long: PropertyType.Long, double: PropertyType.Double };
            const el = codec[lijst[1]] ?? PropertyType.Object;
            const items: unknown[] = [];
            try {
              const count = sub.integer();
              for (let i = 0; i < count && sub.remaining > 0; i++) items.push(this.readValue(sub, el));
            } catch { /* a truncated list: what there is */ }
            return { $type: def.name, $count: items.length, $items: items };
          }
          const obj: Record<string, unknown> = {};
          for (;;) {
            const idx = sub.flexInt();
            if (idx === 0) break;
            const m = def.members[idx - 1];
            if (!m) break;
            try { obj[m.name] = this.readValue(sub, m.propType); } catch { break; }
          }
          return { $type: def.name, ...obj };
        }
        return marker === 0n ? null : ({ $ref: marker } as ObjRef);
      }
      case PropertyType.LengthPrefixed: {
        const len = r.integer();
        return r.bytes(len);
      }
      default:
        throw new Error(`unknown PropertyType ${t}`);
    }
  }

  /**
   * Decode a single method-return value that was serialized with the `Object`
   * (GetObject) encoding — i.e. `flexLong(marker)` then, for marker==1, an inline
   * value object (typeId + length + sparse fields). Returns `{$type, ...fields}`
   * for an inline struct, `{$ref}` for a by-ref oid, or `null`. Used for by-value
   * returns like `GetAlbumEditInfo` whose result is not pushed into the graph.
   */
  decodeReturnValue(payload: Uint8Array): unknown {
    return this.readValue(new BinaryReader(payload), PropertyType.Object);
  }

  // --- queries ---

  /** All objects whose type name equals or ends with the given short name. */
  findByType(shortName: string): RoonObject[] {
    const want = shortName.includes('.') ? shortName : `.${shortName}`;
    return [...this.objects.values()].filter(
      (o) => o.typeName === shortName || o.typeName.endsWith(want)
    );
  }

  getObject(oid: bigint | number): RoonObject | undefined {
    return this.objects.get(oid.toString());
  }
}
