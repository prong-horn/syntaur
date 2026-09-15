# Syntaur Protocol Summary

Protocol version: **2.0**

See `syntaur show` for ticket-specific file lists. Modern templates use `journal.md` as the CLI-mediated log role; append via `syntaur log -t <type>` (seven types). `syntaur progress log` aliases `-t progress`. Legacy templates merge sidecars with `syntaur migrate journal`.

Stages: backlog, planning, ready, in_progress, review, done, dropped. Flags: blocked, parked.

Ticket folders: `~/.syntaur/projects/<project>/tickets/<ID>-<slug>/`.
