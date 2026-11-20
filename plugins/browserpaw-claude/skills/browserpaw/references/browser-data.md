# Browser data

Run `browserpaw help data` for command families and `browserpaw help COMMAND` for the installed syntax.

History, bookmarks, download records, and cookies apply to the current Chrome profile. Storage requires a tab or task and binds to the selected main document.

## History

```text
browserpaw history search example.com --since 7d --limit 20
browserpaw history visits https://example.com/ --since 24h
browserpaw history top --since 7d --limit 10
```

Use an ISO date, epoch milliseconds, or a relative value such as `24h`. Search defaults to one day and top to seven days. Top counts visits within the time window across up to 200 recently matching URLs. Check `truncated` before interpreting the ranking. Remove exact URLs with `history rm URL`. Range removal requires both dates and `--yes`.

## Bookmarks

```text
browserpaw bookmark tree
browserpaw bookmark export --folder 18 --format html --out bookmarks-backup.html
browserpaw bookmark mkdir Research --folder 18
browserpaw bookmark mv 27 --folder 18
browserpaw bookmark dedupe --folder 18
```

Use the IDs returned by tree and search. An absolute folder path starts at an existing Chrome folder and uses its actual displayed title. Use IDs for duplicate titles or titles containing slashes. Preview deduplication first, then add `--apply` for the selected folder. Chrome folders and URL fragments retain their distinct identities. Removing a nonempty folder requires `--recursive`. An existing export file causes an error.

## Downloads, storage, and cookies

- `download` starts or waits for a download. `downloads list` reads Chrome's list. `downloads reveal ID` asks Chrome to show the file in the OS file manager. `downloads rm ID` removes the list entry and `--file` also deletes the file.
- `storage get --tab ID` lists keys. Add a key to read its value. Use `--session` for sessionStorage. `storage set`, `storage rm`, and `storage clear` apply to the selected document origin and storage area.
- `cookies list --url URL` returns metadata. Add `--values` only when the task needs values from the specified URL or domain. Cookie commands operate on unpartitioned cookies in the default store. Chrome selects a cookie for removal by URL and name. Keep values out of saved recipes and logs.
