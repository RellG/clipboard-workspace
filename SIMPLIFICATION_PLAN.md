# Workspace design notes

## Experience

Use a library → list → detail layout with Notes, Documents, and Media as primary destinations. Keep Archive, Trash, and Settings secondary. On phones, use list → detail navigation with Back. Preserve the list position when returning from a note or after background sync.

Notes edit existing records in place, with captured per-record drafts, serialized autosaves, and explicit conflict recovery. Minimize is a view preference, independent of Trash. Snapshot creation is explicit. The save status must acknowledge actual persistence.

Files retain their original bytes and download names. Documents and Media classify existing files without duplicating or moving them. Attachments link to stored file IDs. Trashing a note does not delete linked files.

Keep the interface lightweight: system fonts, light/dark themes, one search field, compact previews, optional code mode, and no decorative animation. Bound scrolling regions to the viewport and preserve touch momentum by leaving unchanged list rows in place.

## Safety and validation

Preserve existing IDs, private content, tab order, and file hashes. New archive, pin, and trash fields are optional. Restore removes flags. Keep snapshots, atomic database writes, and persistence failure recovery.

Validate with isolated synthetic fixtures: API contracts, malformed input, lossless transfers, concurrency/SSE, unchanged legacy records, lifecycle operations, conflicts, save failures, and desktop/mobile scrolling. Never use production data or a live mutation-test target.

## Optional integrations

The converter shortcut uses a privately configured HTTP/HTTPS URL. Its address and the host's port mappings belong in ignored environment configuration, not the source tree.

Installation inventories, account identities, access commands, absolute paths, deployment logs, and backup locations must be maintained privately outside this repository.
