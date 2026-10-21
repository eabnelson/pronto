package credential

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode/utf16"

	"github.com/syndtr/goleveldb/leveldb"
	"github.com/syndtr/goleveldb/leveldb/opt"
)

// Workspace represents a Slack workspace with its extracted token.
type Workspace struct {
	ID    string
	Name  string
	URL   string
	Token string
}

// extractTokens reads xoxc tokens from Slack's LevelDB.
var snapshotDirectory string

func SetSnapshotDirectory(directory string) { snapshotDirectory = directory }

func extractTokens(leveldbDir string) ([]Workspace, error) {
	canonical, err := filepath.EvalSymlinks(leveldbDir)
	if err != nil || canonical != filepath.Clean(leveldbDir) {
		return nil, fmt.Errorf("unsafe profile path")
	}

	// Copy to temp dir (Slack holds the lock on the original)
	tmpDir, err := os.MkdirTemp(snapshotDirectory, fmt.Sprintf("snapshot-%d-*", os.Getpid()))
	if err != nil {
		return nil, fmt.Errorf("create temp dir: %w", err)
	}
	defer os.RemoveAll(tmpDir)

	if err := copyDir(leveldbDir, tmpDir); err != nil {
		return nil, fmt.Errorf("copy leveldb: %w", err)
	}

	// Remove LOCK file so we can open it
	os.Remove(filepath.Join(tmpDir, "LOCK"))

	db, err := leveldb.OpenFile(tmpDir, &opt.Options{ReadOnly: true})
	if err != nil {
		return nil, fmt.Errorf("inconsistent read-only snapshot")
	}
	defer db.Close()

	// Find localConfig_v2 key
	iter := db.NewIterator(nil, nil)
	defer iter.Release()

	for iter.Next() {
		key := string(iter.Key())
		if !strings.Contains(key, "localConfig_v2") {
			continue
		}

		value := iter.Value()
		jsonStr, err := decodeValue(value)
		if err != nil {
			continue
		}

		workspaces, err := parseWorkspaces(jsonStr)
		if err != nil {
			continue
		}
		if len(workspaces) > 0 {
			return workspaces, nil
		}
	}

	return nil, fmt.Errorf("no localConfig_v2 found in Slack's local storage")
}

// decodeValue handles the various encodings Slack uses for LevelDB values.
func decodeValue(raw []byte) (string, error) {
	if len(raw) == 0 {
		return "", fmt.Errorf("empty value")
	}

	// Strip 1-byte prefix (\x00, \x01, \x02) if present
	data := raw
	if len(data) > 0 && data[0] <= 0x02 {
		data = data[1:]
	}

	// Detect UTF-16LE by checking for NUL bytes interleaved with ASCII
	if isUTF16LE(data) {
		return decodeUTF16LE(data)
	}

	return string(data), nil
}

// isUTF16LE heuristic: if >20% of bytes are NUL and length is even, likely UTF-16LE.
func isUTF16LE(data []byte) bool {
	if len(data) < 4 || len(data)%2 != 0 {
		return false
	}
	nuls := 0
	for _, b := range data {
		if b == 0 {
			nuls++
		}
	}
	return float64(nuls)/float64(len(data)) > 0.2
}

// decodeUTF16LE converts UTF-16LE bytes to a Go string.
func decodeUTF16LE(data []byte) (string, error) {
	if len(data)%2 != 0 {
		data = data[:len(data)-1]
	}
	u16 := make([]uint16, len(data)/2)
	for i := range u16 {
		u16[i] = binary.LittleEndian.Uint16(data[i*2:])
	}
	return string(utf16.Decode(u16)), nil
}

// localConfig is the JSON structure of Slack's localConfig_v2.
type localConfig struct {
	Teams map[string]struct {
		Token string `json:"token"`
		Name  string `json:"name"`
		URL   string `json:"url"`
	} `json:"teams"`
}

// parseWorkspaces extracts workspace info from the localConfig_v2 JSON.
func parseWorkspaces(jsonStr string) ([]Workspace, error) {
	// The value might have leading/trailing garbage; find the JSON object
	start := strings.Index(jsonStr, "{")
	if start < 0 {
		return nil, fmt.Errorf("no JSON object found")
	}

	var cfg localConfig
	if err := json.Unmarshal([]byte(jsonStr[start:]), &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	var workspaces []Workspace
	for id, team := range cfg.Teams {
		if !strings.HasPrefix(team.Token, "xoxc-") {
			continue
		}
		workspaces = append(workspaces, Workspace{
			ID:    id,
			Name:  team.Name,
			URL:   team.URL,
			Token: team.Token,
		})
	}
	sort.Slice(workspaces, func(i, j int) bool {
		return workspaces[i].Name < workspaces[j].Name
	})
	return workspaces, nil
}

// copyDir copies all files from src to dst (non-recursive, files only).
func copyDir(src, dst string) error {
	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}
	if len(entries) > 512 {
		return fmt.Errorf("snapshot file limit")
	}
	var total int64
	for _, e := range entries {
		if e.Name() == "LOCK" {
			continue
		}
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() || e.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe snapshot entry")
		}
		total += info.Size()
		if info.Size() > 64<<20 || total > 128<<20 {
			return fmt.Errorf("snapshot byte limit")
		}
		srcPath := filepath.Join(src, e.Name())
		dstPath := filepath.Join(dst, e.Name())
		if err := copyFile(srcPath, dstPath, info.Size()); err != nil {
			return fmt.Errorf("copy %s: %w", e.Name(), err)
		}
	}
	return nil
}

func copyFile(src, dst string, expected int64) error {
	in, err := os.OpenFile(src, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer out.Close()

	n, err := io.Copy(out, io.LimitReader(in, expected+1))
	if err == nil && n != expected {
		return fmt.Errorf("snapshot changed during copy")
	}
	return err
}
