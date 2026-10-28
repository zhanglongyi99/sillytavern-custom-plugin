# Revision start validation

Initial, unterminated responses must identify the body with the existing body
or final protocol before becoming a continuation prefix. A length threshold
alone is insufficient. Complete responses and continuations of an established
draft keep their existing behavior. This is a protocol check, not proof of
semantic correctness; completeness checks and manual review remain necessary.

Parsed-response diagnostics record host-interface length, configured visible
and reasoning lengths (when available), and parser failure without recording
the contents. The host quiet/raw generation APIs return text only, so
`upstreamMetadataAvailable: false` explicitly means finish reason and HTTP
usage are unavailable. `providerCharacters` is retained for compatibility but
is the host-returned string length, not the raw HTTP response size.

An invalid initial fragment stays in the bounded initial-attempt workflow and
does not trigger continuation calls. Failure keeps the current candidate and
reports the specific progress reason. No new automatic calls are introduced.

This change does not implement patch-based editing or change retry limits,
model settings, reasoning settings, or output budgets.
