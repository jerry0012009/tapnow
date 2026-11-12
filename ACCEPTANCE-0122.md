# Companion 0.1.22

Continues the handed-off private-image-assist changes without modifying the
original task worktree. Review re-reads the current draft, attaches source-grounded
creative memory from ACU, and discards late responses after prompt, node, canvas,
reference binding or image changes. Current intent overrides historical rules;
old outputs are not assumed to reflect a newly edited prompt.

Verification on 2026-11-13:
- 77 unit tests passed.
- Type baseline comparison added no diagnostics; eight pre-existing diagnostics
  remain. This is not a clean full TypeScript check.
- Production companion ZIP built and each entry checked against the build output.
- Sandboxed system Chrome, isolated temporary profile and network-blocked bundle
  harness passed classic/V2 routes, live editing, memory forwarding, prompt edits
  during review, SPA/remount/reinjection, desktop/mobile and read-only requests.
- Earlier browser launch attempts failed because an old browser path was missing
  and a temporary CfT path lacked sandbox permission. System Chrome succeeded;
  host sandbox protection was not disabled.

Artifact: `releases/tapnow-companion-0.1.22-chrome.zip`.
SHA256: `e1cccfc82d3f48bce6d0ee3dc1b4484c27106cbcbe0176cba277a94199bfbe46`.
No owner API credential is embedded. The installed extension's existing API
settings remain authoritative. This artifact has not been installed into the
user's actual browser or verified against a logged-in live TapNow canvas.
