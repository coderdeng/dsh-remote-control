# Changelog

## 0.2.1

- fix(controller): strip `undefined` members from tool results before returning them
  (DSH rejects tool outputs that are not lossless JSON, which broke `remote_dsh_hosts`
  for hosts configured without a description); add a regression assertion over every
  tool output.
- feat(controller): `remote_dsh_pair` now accepts `name` to rename a host while pairing.

## 0.2.0

- feat: zero-config worker deployment — `scripts/worker-setup.sh` finds the DSH CLI,
  clones this repository, creates the profile, generates/reuses a token, picks a free
  port, writes the profile patch, starts the worker in the background and prints a
  pairing code.
- feat(worker): auto-generate a token when none is configured; fall back to the next
  free port when the configured one is taken; publish endpoint/token/pairing code to
  `<DSH_HOME>/dsh-remote-control/worker.json` (mode 0600) and the log.
- feat(controller): `remote_dsh_pair` / `remote_dsh_unpair` tools; paired hosts persist
  in `<DSH_HOME>/dsh-remote-control/hosts.json` and merge with `config.hosts`, so adding
  a remote computer no longer requires editing profile configuration.
- feat: pairing codes (`dshrc1.<base64url JSON>`) carrying endpoint + token + host name.

## 0.1.0

- Initial release: controller tools (`remote_dsh_hosts/start/wait/send/status/log/abort`)
  and the worker HTTP bridge over real DSH sessions; per-session `danger-full-access`
  preset, transcript cursors, resume, unit + end-to-end tests.
