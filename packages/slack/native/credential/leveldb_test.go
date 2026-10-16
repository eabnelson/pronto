package credential

import (
	"github.com/syndtr/goleveldb/leveldb"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateReadOnlySnapshot(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source")
	snapshots := filepath.Join(root, "snapshots")
	_ = os.Mkdir(snapshots, 0700)
	SetSnapshotDirectory(snapshots)
	db, err := leveldb.OpenFile(source, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Synthetic test fixture, never a usable session credential.
	err = db.Put([]byte("localConfig_v2"), []byte(`{"teams":{"TFIXTURE":{"name":"Synthetic workspace","token":"xoxc-fixture-only","url":"https://example.slack.com"}}}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	before, err := os.ReadFile(filepath.Join(source, "CURRENT"))
	if err != nil {
		t.Fatal(err)
	}
	workspaces, err := ReadDesktopWorkspaces(source)
	if err != nil || len(workspaces) != 1 || workspaces[0].Name != "Synthetic workspace" {
		t.Fatalf("snapshot read failed: %v", err)
	}
	after, _ := os.ReadFile(filepath.Join(source, "CURRENT"))
	if string(after) != string(before) {
		t.Fatal("live profile changed")
	}
	remaining, _ := os.ReadDir(snapshots)
	if len(remaining) != 0 {
		t.Fatal("snapshot retained after read")
	}
	if err = os.Symlink(filepath.Join(root, "unrelated"), filepath.Join(source, "unsafe")); err != nil {
		t.Fatal(err)
	}
	if _, err = ReadDesktopWorkspaces(source); err == nil {
		t.Fatal("symlink accepted")
	}
}
func TestSnapshotRejectsOversizedProfile(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "source")
	snapshots := filepath.Join(root, "snapshots")
	_ = os.Mkdir(source, 0700)
	_ = os.Mkdir(snapshots, 0700)
	SetSnapshotDirectory(snapshots)
	file, err := os.Create(filepath.Join(source, "oversized.ldb"))
	if err != nil {
		t.Fatal(err)
	}
	err = file.Truncate(65 << 20)
	_ = file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ReadDesktopWorkspaces(source); err == nil {
		t.Fatal("snapshot budget ignored")
	}
	remaining, _ := os.ReadDir(snapshots)
	if len(remaining) != 0 {
		t.Fatal("failed snapshot retained")
	}
}
