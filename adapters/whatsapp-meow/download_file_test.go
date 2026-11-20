package main

import (
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow"
)

func TestStagedMediaDownloadBoundsDiskAndRemovesTempFiles(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	tests := []struct {
		name     string
		download func(whatsmeow.File) error
		want     error
	}{
		{"success transfers ownership", func(file whatsmeow.File) error {
			_, err := io.Copy(file, strings.NewReader("synthetic"))
			return err
		}, nil},
		{"disk cap applies to sequential copies", func(file whatsmeow.File) error {
			if _, err := file.Seek(64_000_026, io.SeekStart); err != nil {
				return err
			}
			src := strings.NewReader("x")
			_, err := io.Copy(file, struct{ io.Reader }{src}) // Force the io.Copy destination fast-path check.
			return err
		}, errMediaSize},
		{"disk cap applies to random writes", func(file whatsmeow.File) error {
			_, err := file.WriteAt([]byte("x"), 64_000_026)
			return err
		}, errMediaSize},
		{"disk cap applies to truncate", func(file whatsmeow.File) error {
			return file.Truncate(64_000_027)
		}, errMediaSize},
		{"remaining plaintext cap excludes encryption overhead", func(file whatsmeow.File) error {
			_, err := file.WriteAt([]byte("x"), 64_000_000)
			if err != nil {
				return errors.New("encrypted staging rejected allowed overhead")
			}
			return nil
		}, errMediaSize},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, err := stageMediaDownload(t.Context(), nil, func(_ context.Context, _ whatsmeow.DownloadableMessage, file whatsmeow.File) error {
				info, err := file.Stat()
				if err != nil {
					t.Fatal(err)
				}
				if got := info.Mode().Perm(); got != 0o600 {
					t.Errorf("media spool permissions = %o, want 600", got)
				}
				downloadErr := tc.download(file)
				info, err = file.Stat()
				if err != nil {
					t.Fatal(err)
				}
				if info.Size() > 64_000_026 {
					t.Errorf("media spool grew to %d bytes before staging returned", info.Size())
				}
				return downloadErr
			})
			if !errors.Is(err, tc.want) {
				t.Errorf("staging error = %v, want %v", err, tc.want)
			}
			if body != nil {
				data, readErr := io.ReadAll(io.LimitReader(body, 32))
				if readErr != nil || string(data) != "synthetic" {
					t.Errorf("download body = %q, %v; want rewind to synthetic bytes", data, readErr)
				}
				if err := body.Close(); err != nil {
					t.Errorf("close staged media: %v", err)
				}
			} else if tc.want == nil {
				t.Error("successful staging returned no body")
			}
			entries, listErr := os.ReadDir(dir)
			if listErr != nil || len(entries) != 0 {
				t.Errorf("download staging directory after Close or error = %v, %v; want empty", entries, listErr)
			}
		})
	}
}
