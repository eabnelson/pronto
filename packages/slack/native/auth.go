package main

/*
#cgo LDFLAGS: -framework CoreFoundation -framework Security -framework IOKit -lsqlite3
#include "platform.h"
#include <string.h>
*/
import "C"
import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/sha1"
	"errors"
	"os"
	"path/filepath"
	"pronto-slack-helper/credential"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

type workspace struct {
	Team    string `json:"team"`
	Label   string `json:"label"`
	Profile string `json:"profile"`
	token   string
}

func profileDirectory() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.New("slack-profile-unavailable")
	}
	directory := filepath.Join(home, "Library/Application Support/Slack")
	// Only the qualified direct-download profile. Never switch profiles automatically.
	if stat, err := os.Lstat(directory); err != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("slack-profile-unavailable")
	}
	return directory, nil
}
func discover() ([]workspace, error) {
	directory, err := profileDirectory()
	if err != nil {
		return nil, err
	}
	cache := filepath.Join(directory, "..", "pronto", "slack-snapshots")
	if err = privateDirectory(cache); err != nil {
		return nil, err
	}
	entries, _ := os.ReadDir(cache)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "snapshot-") {
			continue
		}
		fields := strings.Split(entry.Name(), "-")
		if len(fields) != 3 {
			continue
		}
		pid, parseError := strconv.Atoi(fields[1])
		if parseError != nil || pid <= 0 {
			continue
		}
		if syscall.Kill(pid, 0) == syscall.ESRCH {
			_ = os.RemoveAll(filepath.Join(cache, entry.Name()))
		}
	}
	credential.SetSnapshotDirectory(cache)
	var rows []credential.Workspace
	for attempt := 0; attempt < 2; attempt++ {
		rows, err = credential.ReadDesktopWorkspaces(filepath.Join(directory, "Local Storage/leveldb"))
		if err == nil {
			break
		}
	}
	if err != nil {
		return nil, errors.New("slack-profile-unavailable")
	}
	result := make([]workspace, 0, len(rows))
	for _, row := range rows {
		result = append(result, workspace{Team: row.ID, Label: row.Name, Profile: "direct", token: row.Token})
	}
	return result, nil
}
func nativeBytes(call func(**C.uchar, *C.int) C.int) ([]byte, error) {
	var data *C.uchar
	var size C.int
	if call(&data, &size) != 0 {
		return nil, errors.New("slack-needs-link")
	}
	defer C.free(unsafe.Pointer(data))
	defer C.memset(unsafe.Pointer(data), 0, C.size_t(size))
	return C.GoBytes(unsafe.Pointer(data), size), nil
}
func readSession(team string, interactive bool) (*session, error) {
	rows, err := discover()
	if err != nil {
		return nil, err
	}
	var token string
	for _, row := range rows {
		if row.Team == team {
			token = row.token
		}
	}
	if token == "" {
		return nil, errors.New("slack-needs-link")
	}
	directory, err := profileDirectory()
	if err != nil {
		return nil, err
	}
	var encrypted []byte
	for _, relative := range []string{"Cookies", "Network/Cookies"} {
		cookiePath := filepath.Join(directory, relative)
		stat, e := os.Lstat(cookiePath)
		if e != nil || !stat.Mode().IsRegular() || stat.Mode()&os.ModeSymlink != 0 {
			continue
		}
		file := C.CString(cookiePath)
		encrypted, err = nativeBytes(func(data **C.uchar, size *C.int) C.int { return C.slack_cookie(file, data, size) })
		C.free(unsafe.Pointer(file))
		if err == nil {
			break
		}
	}
	if err != nil || len(encrypted) < 19 {
		return nil, errors.New("slack-cookie-unavailable")
	}
	if string(encrypted[:3]) != "v10" && string(encrypted[:3]) != "v11" {
		return nil, errors.New("slack-cookie-version")
	}
	flag := C.int(0)
	if interactive {
		flag = 1
	}
	password, err := nativeBytes(func(data **C.uchar, size *C.int) C.int { return C.slack_keychain(flag, data, size) })
	if err != nil {
		return nil, err
	}
	defer clear(password)
	key, err := pbkdf2.Key(sha1.New, string(password), []byte("saltysalt"), 1003, 16)
	if err != nil {
		return nil, errors.New("slack-cookie-unavailable")
	}
	defer clear(key)
	block, err := aes.NewCipher(key)
	if err != nil || (len(encrypted)-3)%aes.BlockSize != 0 {
		return nil, errors.New("slack-cookie-unavailable")
	}
	plain := make([]byte, len(encrypted)-3)
	defer clear(plain)
	cipher.NewCBCDecrypter(block, bytes.Repeat([]byte{' '}, aes.BlockSize)).CryptBlocks(plain, encrypted[3:])
	padding := int(plain[len(plain)-1])
	if padding < 1 || padding > aes.BlockSize || padding > len(plain) {
		return nil, errors.New("slack-cookie-unavailable")
	}
	for _, b := range plain[len(plain)-padding:] {
		if int(b) != padding {
			return nil, errors.New("slack-cookie-unavailable")
		}
	}
	plain = plain[:len(plain)-padding]
	start := bytes.Index(plain, []byte("xoxd-"))
	if start < 0 {
		return nil, errors.New("slack-cookie-unavailable")
	}
	return &session{team: team, token: token, cookie: string(plain[start:])}, nil
}
func startPower() error {
	if C.slack_power_start() != 0 {
		return errors.New("slack-power-unavailable")
	}
	return nil
}
func wakeCount() int { return int(C.slack_power_wake_count()) }
