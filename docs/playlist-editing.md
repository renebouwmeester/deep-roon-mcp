# Experimental playlist editing

The four write tools are opt-in with `DEEP_ROON_PLAYLIST_EDIT=1`. Both normal `DEEP_ROON_READ_ONLY` modes hide them, and execution has an independent read-only guard.

`roon_playlist_snapshot(key)` reads complete membership and supplies a hash revision and stable occurrence IDs. The writes require an exact playlist key, the current revision and `confirm:true`:

- `roon_playlist_add_tracks(key, revision, confirm, keys, before?)`: insert ordered track keys, before an occurrence or at the end.
- `roon_playlist_remove_tracks(key, revision, confirm, items)`: remove selected occurrence IDs, retaining other copies of duplicate tracks.
- `roon_playlist_reorder_tracks(key, revision, confirm, items, before?)`: move selected occurrences in their original relative order, before an anchor or to the end.
- `roon_playlist_rename(key, revision, confirm, name)`: rename with overwrite=false.

Only native `PlaylistType.Sooloos`=5 playlists are editable. Imported, service, editorial, smart and read-only playlists are refused. Roon's sparse objects omit default false booleans: an omitted IsReadOnly is accepted only with the server's explicit bool schema and complete validated native-playlist membership. Explicit true or unknown/wrong schema is refused.

Each request reads the complete state, validates added track keys, then rechecks the revision immediately before one write. Session-local object references come from that final snapshot. Every write reads the full result back and verifies name, track order and surviving occurrence identities. An acknowledgement alone never produces success. Uncertain results are never automatically retried or rolled back.

## Protocol provenance

The exact signatures come from the vendored client's upstream [authoritative catalog](https://github.com/arthursoares/roon-api-reverse-engineering/blob/8b67208f640e760f3b18431140e17469a059e90c/roon-internal-api/src/catalog/catalog.authoritative.json) and [generated wrappers](https://github.com/arthursoares/roon-api-reverse-engineering/blob/8b67208f640e760f3b18431140e17469a059e90c/roon-internal-api/src/generated/api.ts#L8949):

- GetPlaylist(Sooid, ResultCallback<Playlist>) and Playlist::GetItems(ResultCallback<Query<PlaylistItem>>) for fresh reads.
- InsertMedia(Playlist, IEnumerable<long>, InsertionPoint, PlaylistItem, ResultCallback<PlaylistInsertionResult>).
- RemoveItems(Playlist, IEnumerable<PlaylistItem>), **without a callback**.
- MoveItems(Playlist, IEnumerable<PlaylistItem>, InsertionPoint, PlaylistItem, ResultCallback).
- Rename(Playlist, string, bool, ResultCallback), always passing false for overwrite.

InsertionPoint End=1 and Before=3 are used. Occurrence IDs identify duplicate copies independently. The test fixture records the authoritative signatures and enum.

## Validation and limits

`npm run check`, `npm test` (44 tests), and `npm run build` pass. Tests use synthetic graph data and injected IO; they do not contact a Core. They cover exact signatures/argument bytes, duplicates/order, stale and incomplete snapshots, schema-bound sparse booleans, read-only/opt-in guards, concurrent pre-write changes, invalid tracks, delayed/partial/failed read-back, and no automatic retry.

The four operations were also verified on Roon Core 2.74 (build 1716) using a disposable native playlist, including duplicate-aware removal, anchored insertion, anchored/end reorder, rename, stale-revision refusal, and empty insertion/removal. Existing playlists were not edited.

This remains unofficial, version-sensitive protocol support. Full membership must resolve within the read deadline. Up to 200 inserted/selected occurrences are accepted per edit. There is no atomic server-side compare-and-swap: another client can change the playlist between the final check and write. Verification detects an unexpected result but cannot eliminate that race.
