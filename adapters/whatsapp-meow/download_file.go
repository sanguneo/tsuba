package main

import (
	"context"
	"crypto/aes"
	"errors"
	"fmt"
	"io"
	"os"

	"go.mau.fi/whatsmeow"
)

// AES-CBC PKCS#7 padding adds up to one block, followed by the 10-byte media MAC.
const maxEncryptedMediaBytes = maxUploadBytes + aes.BlockSize + 10

var errMediaSize = errors.New("media exceeds download limit")

type downloadBody struct {
	io.Reader
	file *os.File
}

func (body downloadBody) Close() error {
	return errors.Join(body.file.Close(), os.Remove(body.file.Name()))
}

// Embed only the SDK interface: exposing *os.File's ReadFrom would bypass Write
// during io.Copy. The wrapper also prevents the SDK from preallocating via Stat.
type boundedDownloadFile struct {
	whatsmeow.File
	ctx context.Context
}

func (f boundedDownloadFile) Write(p []byte) (int, error) {
	offset, err := f.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, fmt.Errorf("read media write offset: %w", err)
	}
	if err := f.checkSize(offset, int64(len(p))); err != nil {
		return 0, err
	}
	return f.File.Write(p)
}

func (f boundedDownloadFile) WriteAt(p []byte, offset int64) (int, error) {
	if err := f.checkSize(offset, int64(len(p))); err != nil {
		return 0, err
	}
	return f.File.WriteAt(p, offset)
}

func (f boundedDownloadFile) Truncate(size int64) error {
	if err := f.checkSize(0, size); err != nil {
		return err
	}
	return f.File.Truncate(size)
}

func (f boundedDownloadFile) Read(p []byte) (int, error) {
	if err := f.ctx.Err(); err != nil {
		return 0, err
	}
	return f.File.Read(p)
}

func (f boundedDownloadFile) ReadAt(p []byte, offset int64) (int, error) {
	if err := f.ctx.Err(); err != nil {
		return 0, err
	}
	return f.File.ReadAt(p, offset)
}

func (f boundedDownloadFile) checkSize(offset, size int64) error {
	if offset < 0 || size < 0 || offset > maxEncryptedMediaBytes || size > maxEncryptedMediaBytes-offset {
		return errMediaSize
	}
	return f.ctx.Err()
}

func stageMediaDownload(
	ctx context.Context,
	media whatsmeow.DownloadableMessage,
	download func(context.Context, whatsmeow.DownloadableMessage, whatsmeow.File) error,
) (body io.ReadCloser, err error) {
	file, err := os.CreateTemp("", "tsuba-meow-media-*")
	if err != nil {
		return nil, fmt.Errorf("create media download file: %w", err)
	}
	result := downloadBody{Reader: file, file: file}
	defer func() {
		if body == nil {
			err = errors.Join(err, result.Close())
		}
	}()
	if err := download(ctx, media, boundedDownloadFile{File: file, ctx: ctx}); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stat downloaded media: %w", err)
	}
	if info.Size() > maxUploadBytes {
		return nil, errMediaSize
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind downloaded media: %w", err)
	}
	return result, nil
}
