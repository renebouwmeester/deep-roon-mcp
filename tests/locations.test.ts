import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseLocations, locationName, type LocationInfo } from '../src/roon/locations';

// As Roon 2.75 build 1725 reports them (Library::GetAlbumQueryInfo → Locations), measured 21 Nov 2026.
const library: LocationInfo[] = [
  { ref: 1n, name: '1', displayName: 'Lossless', category: 100 },
  { ref: 2n, name: '2', displayName: 'Classical', category: 100 },
  { ref: 3n, name: '3', displayName: 'Hi-Res', category: 100 },
  { ref: 4n, name: 'TIDAL Library', displayName: 'TIDAL Library', category: 400 },
  { ref: 5n, name: '5', displayName: 'DSD', category: 100 }
];

test('local means every local storage location, not only the first', () => {
  assert.deepEqual(chooseLocations(library, 'local'), [1n, 2n, 3n, 5n]);
});

test('tidal and qobuz still pick the streaming location', () => {
  assert.deepEqual(chooseLocations(library, 'tidal'), [4n]);
  assert.deepEqual(chooseLocations(library, 'TIDAL'), [4n]);
  assert.deepEqual(chooseLocations(library, 'qobuz'), []);
});

test('a storage location is picked by the name Roon shows for it, ignoring case, and only exactly', () => {
  assert.deepEqual(chooseLocations(library, 'Hi-Res'), [3n]);
  assert.deepEqual(chooseLocations(library, 'classical'), [2n]);
  assert.deepEqual(chooseLocations(library, 'Hi'), []);
  assert.deepEqual(chooseLocations(library, 'Lossless Hi-Res'), []);
});

test('Focus names a local folder by the name Roon shows, and TIDAL/Qobuz by their service', () => {
  assert.deepEqual(library.map(locationName), ['Lossless', 'Classical', 'Hi-Res', 'TIDAL', 'DSD']);
  assert.equal(locationName({ ref: 9n, name: '9', displayName: '', category: 100 }), 'Local');
  assert.equal(locationName({ ref: 9n, name: 'qobuz Library', displayName: '', category: 400 }), 'Qobuz');
  assert.equal(locationName({ ref: 9n, name: 'qobuz Library', displayName: 'qobuz Library', category: 400 }), 'Qobuz');
});
