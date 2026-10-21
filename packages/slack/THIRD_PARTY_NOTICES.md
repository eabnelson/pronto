# Third-party notices

`native/credential/leveldb.go` adapts the MIT-licensed LevelDB reader from sttts/slagent, commit `4b959bdf2a8207daeb597ed8f2ed360b2c7f51a9`. The upstream license and copyright are retained in `native/credential/LICENSE`. Pronto adds bounded private snapshots, symlink checks, and read-only failure behavior; no live LevelDB writer or recovery writer is used.

Native dependencies are pinned in `native/go.mod` and `native/go.sum`:

- github.com/gorilla/websocket v1.5.3, BSD-2-Clause.
- github.com/syndtr/goleveldb v1.0.0, BSD-2-Clause.
- github.com/golang/snappy v0.0.0-20180518054509-2e65f85255db, BSD-3-Clause.

Dependency licenses are distributed in `native/licenses/`. The helper is built from source and embedded into the verified executable. It does not download dependencies or executables at runtime.
