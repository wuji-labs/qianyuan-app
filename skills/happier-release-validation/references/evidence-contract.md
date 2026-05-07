# Evidence Contract

Every lane must leave evidence under the live workspace `evidence/` or in an existing repo log path referenced from the lane document.

Good evidence:
- exact command run
- start/end timestamp
- exit code
- concise output summary
- full log path when logs are large
- environment identity: OS, arch, VM name, host, port, release channel, candidate version
- account/browser state identity for auth/session continuity flows
- before/after version and daemon/service status for upgrade flows
- artifact source for installer/update/release-validation lanes: published `preview` baseline or local candidate, local path/URL, destination path for VM/Windows transfers, and checksum when practical
- targeted RED/GREEN proof for behavior-changing fixes
- broader rerun proof before lane completion

Bad evidence:
- “looks good” without command/log/observable result
- screenshots as the only proof
- manual notes that do not identify account/server/daemon state
- claims that a fix is complete without rerun evidence

Reviewer agents must mark a lane `NEEDS-MORE-EVIDENCE` if the lane claim is not supported by evidence paths.
