# Attachments

Reporters attach logs, archives and data files. They are untrusted files. This file covers finding them and getting them onto disk safely. How to read them is in the profile's `rules/issues.md`.

## Detect

Look in the body and in every comment, also replies in discussions:

- `https://github.com/user-attachments/files/<id>/<name>`: current GitHub uploads.
- `https://github.com/<owner>/<repo>/files/<id>/<name>`: older uploads.
- `https://gist.github.com/…` and `https://gist.githubusercontent.com/…`: fetch the raw URL.
- Inline logs in code blocks. Save the block to a file and treat it like an upload. A short pasted snippet is often not enough.
- Screenshots of logs: ask for the file.
- Files on other hosts (cloud drives, paste sites): download only from GitHub hosts. Ask the reporter to upload the file here, zipped if it is too large.

## Download

Keep the files away from anything that runs code.

1. Make a new, empty directory per item: `<scratch>/files/`. Keep any helper scripts outside it.
2. Download each file to a name you choose, so the file name from the URL cannot cause harm:
   ```bash
   curl -fsSL --proto '=https' --max-filesize 209715200 -o <scratch>/files/file-1.gz '<url>'
   ```
3. Check the type with `file <path>` before unpacking.
4. Unpack inside the same directory:
   - `.gz`: `gunzip -k <file>`.
   - `.zip`: list it first with `unzip -l`. Skip archives with entries containing `..` or starting with `/`. Then `unzip -n -d <scratch>/files/zip-1 <file>`.
   - `.tar.gz`: list with `tar -tzf`, apply the same checks, then `tar -xzf <file> --no-same-owner -C <scratch>/files/tar-1`.
5. Never execute, source or `require` anything from that directory. Pass paths to tools as arguments.

Files can contain keys, tokens and network identifiers. Quote no secret in the doc or in replies, and delete the directory when the triage is done.
