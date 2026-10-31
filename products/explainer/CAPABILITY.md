# explainer: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. Keep one export or preset per line so parallel edits merge. -->

You are building a step of the explainer video pipeline and need its file contracts or its pure helpers.
`StoryboardSchema` validates `beats.json` (video type, chapters, beats with stops in seconds),
`DigestSchema` validates `digest.json`,
`LexiconSchema` and `lexiconEntriesFor` cover pronunciations,
`buildPacket` builds one beat builder's packet (throws on a code beat with no excerpt and on a packet over its byte cap), and
`attributeFindings` maps gate findings to the beat each names by beat number.
`claimsCheckWith(facts)` (Q-E20) checks each pull request, task and count a script names against the gathered facts.
`spokenTokenCheckWith(lexicon)` (Q-V14) fails a spoken line with a print device, or a path, code token, unit or acronym that no lexicon entry or phoneme override voices.
`assertionCheckWith(tagger)` (Q-D7) fails a beat headline with no subject and finite verb, over ten words, or written after its narration.
Only `explainer eval l1`, `l2`, `cold`, `items` and `smoke` and `explainer rewrite` (and `rewrite measure`) call a model, through the judge a config file names.
`explainer rewrite` (`rewriteScript`) rewrites a drafted script's spoken lines toward the Q-V11 register bands, one call per chapter a round,
keeps a beat's rewrite only when `guardBeat` accepts it,
moves extra numbers to `visual.labels`, and
with `--speech-vet` lets a vetted 26-32 word sentence through.
`explainer rewrite measure` runs it n times per input and reports each target row's mean, sd and n against the revised done-when, under a spend cap.
Only these touch the filesystem:
the eval store,
the CLI,
the owner kit,
`loadDoctrine`,
`loadProfiles`,
`loadBeatSystems`,
`writeTypeGuides`,
`gatherReview`,
`enrichStructure`,
`gatherDaily`,
`readTaskSnapshot`,
`gatherPr` and
the PR trigger.
Motion primitives and beat components live in `@titan-design/react-ui`, not here; citation checks live in `evidence`.
`lintMapBeats`, `lintMapCues` and `compileMapTimeline` check and time the repo-map track (`visual.map_state`, optional per beat), and
`toDiagramMapTimeline` turns it into titan-design's `MapTimeline` keyframes.
`cameraStation` fits a 16:9 camera box around focus ids, clear of the 83 % caption keep-out.
`ScriptSchema` parses a two-track `script/v1` script (with optional layer, framing, anchor, scene, structure and signature-layer fields),
`parseScript` also rejects a `structure` the registry lacks,
`deriveEvalView` derives the view evals read from it, and
`migrateTourV0` lifts a spike tour to v1.
`emptyStageRuns` fails a beat whose stage area holds no non-decor content box for more than 3 s of measured moments.
`contentFillFindings` fails a beat whose settled element boxes span less than 60 % of the frame width.
`cutCells` cuts beat-aware contact-sheet stills from beat bounds, measured cue times and beat kind (or the page's marks), stable when a beat is lengthened.
`explainer sheets` (`writeContactSheets`) tiles those stills, each with a label strip, into one PNG per chapter.
`scriptSha` names a script by its canonical-JSON sha, and
`explainer eval l0` runs the L0 checks and appends `structure.tsv` and `runs.jsonl` rows that carry `rules_sha`.
For an owner's blind read, `prepareOwnerSession` writes two-track storyboards under a sealed key and
`recordOwnerSession` appends `owner.tsv` rows before it opens the key.
`loadRuleRegistry` reads the shipped Q-rule registry (`doctrine/rules.yaml`), and
`unimplementedL0Rules` reports rules that claim a check no registered L0 check emits.
`loadDoctrine` reads the craft doctrine registry (`doctrine/craft/*.yaml` with its vocabulary and evidence ledger), and
`checkDoctrine` reports missing evidence ids, grades the cited rows do not state, live code-checked rules left in a prompt enforcement, unresolved `qrule` refs and scope errors.
`sliceForStage` returns the craft rules one pipeline stage loads for a video type, audience and beats (prompt, base and packet prose, checks, token names, profile params), never a code-enforced rule in prose, and
`findPromptLeaks` flags a prompt that names a code-enforced doctrine rule or an implemented-L0 Q-rule by id, alias or text.
`loadProfiles` reads the type profiles (`doctrine/types/*.yaml`: repo-tour, the explain-repo default, plus repo-argument, pr-overview, paper-summary and daily-overview) and audience packs.
`profileFor` rejects an unknown type,
`checkProfiles` reports vocabulary, structure, series (`mayRepeat` / `mustVary`), publish-guard and beat-system binding issues,
`chapterOrder` gives a fixed order for the tour and, for the others, the first heuristic row whose registered structure fits the material.
`loadStructures` reads the narrative structure registry (`doctrine/structures/*.yaml`: fifteen structures, each with a fit predicate over material signals, airtime shares and its own spine sections),
`structureFor` rejects an unknown structure, and
`checkStructures` reports vocabulary, signal, share and block issues.
`loadBeatSpecs` reads the beat-spec registry (`doctrine/beats/*.yaml`, one per vocabulary beat, each naming a zod slot schema in `BEAT_SLOTS` and an emphasis contract of target lists and template treatments),
`beatSpecFor` rejects an unknown beat,
`parseBeatSlots` rejects bad slots and duplicate emphasis ids,
`cueElement` resolves a cue target to exactly one emphasis element, and
`fillScript` maps each template beat of a script/v1 and its resolved row to slot props its spec's schema accepts (derived < resolver slots < `visual.slots`), falling back to a list it records and listing every refusal in a `FillError`,
`checkBeatSpecs` reports vocabulary, slot-ref, duration, recipe-length and emphasis-target issues.
`chartFrameProblems` refuses a chart or replot slot set with bars off a zero baseline or on a broken axis, a colour scale whose lightness (`lightness`, CIELAB L*) is out of order (`isMonotonicScale`), or a legend where direct labels fit, behind the resolve `chart-integrity` gate.
`loadBeatSystems` reads the beat-system registry (`doctrine/beat-systems/*.yaml`: nine ordered beat patterns, such as the CL order and BLUF, that a profile binds inside a structure's blocks) and rejects a system or step beat outside the vocabulary,
`beatSystemFor` rejects an unknown system, and
`placeBeatSystem` lands a system's steps in order in a profile's blocks.
`loadStylePacks` reads the style packs (`doctrine/style-packs/*.yaml`: four selections of existing titan-design tokens by slot) and rejects a pack naming a token outside the pinned `tokens.css` names, the wrong kind of token for a slot, or a channel whose look it would copy,
while each profile names the packs it allows and its voice band (Kokoro voice id and rate), and a render variant's `stylePack` puts the pack's content hash in the render key.
For a `sim` beat, a `SimModel` in `SIM_MODELS` simulates from the seed's generator only (`runPure` refuses `Math.random` and clocks with `SimPurityError`),
`sweepSim` runs it over one swept param and an optional facet with a seed per point, and
`freezeSim` seals the runs as an `explainer.sim-trace/v1` trace (`SimTraceSchema`) keyed by its canonical-JSON sha256.
`loadSims` reads the sim-model registry (`doctrine/sims/*.yaml`) and
`checkSims` reports a model with no doctrine file, a file with no model, and a doctrine statistic the model never emits.
`simCheck` passes a sim beat only when its run reproduces a gathered number fact within the doctrine tolerance, refusing a tolerance under 3 se, over a tenth of the claim, or on a fitted statistic, and
`runSimPass` sweeps, freezes and checks every sim beat at resolve, which cuts the failing ones before tts behind the `sim-cut-orphan` gate.
`reviewRounds` is the pilot model (`review-rounds`: round 1 passes with chance p1, later rounds with chance q, emitting mean reviews and the 5+ share, refusing a q under `MIN_LATER_PASS` or a prs over `MAX_REVIEW_PRS`), and
`fitLaterRoundPass` solves q from a gathered 5+ share, which the doctrine lists in `fittedFrom`.
`explainer guide types` writes each type's planner guide to `doctrine/guides/planner/<type>.md`.
`explainer eval l1` and `l2` run the L1 judge and L2 viewer through a configured claude-print or codex judge, void any score without a verbatim quote, plant canaries in every call, and key rows by an `eval_version` over rubric, judge and fixtures.
For pace evals, `fromScriptV1` and `fromSpikeScript` project a script to `PaceBeat`s (the items each beat puts on screen, their role from `CUE_KIND_ROLES`, and which are new),
`readSpikeScript` reads a Python-emitted spike script.json loosely and lists the fields it ignores, and
`readTiming` reads heard durations from a words.json.
`runCold` streams that track to a cold viewer one chapter per call, carrying only its three-line summary, and reports undefined items per chapter minute from generated questions scored against verbatim quotes.
`explainer eval cold` runs it three times by default and appends its rows and run records under an `eval_version` that includes the judge.
`paceCheck` (in `L0_CHECKS`) and `paceRows` lint that item track: Q-E7 at most 4 new items a beat (error), and as warnings Q-E8 seconds a new item, Q-E9 15 s to digest between dense beats and Q-E10 new items a chapter minute (`chapterPace`).
It also lints seating and reuse: Q-E11 a beat that states an invariant needs a map and states at most one (error),
Q-E13 `reuseFindings` names reused `origin: v2` beats that fail Q-E7, Q-E8, Q-E9 or Q-E11 with their heard seconds to re-voice, and
Q-E12 (`seatRoutes`) and Q-E14 (`explainRoutes`) only route beats to the L1 judges and never gate.
`runItems` is that L1 item judge: one call per chapter over `itemRoutes` (explain, seat and list routes, nothing else), asking whether each routed item is explained, each routed beat seated, and which listed item is the odd one out;
it voids any verdict without a verbatim quote, plants a name-only canary beat per call, and
`explainer eval items` runs it three times by default under eval id `L1-items`.
`varietyScriptCheck` (in `L0_CHECKS`) adds the script-only variety lints as warnings: `variety:hook-formula`, `variety:connector-share` (over 30 % of beats opening on so, but, then, and or now), `variety:cue-action` (one cue action across the script) and `variety:framing-run` when beats author `visual.framing`; `resolvedVarietyRows` holds the resolver's choices to the profile's component, template and framing limits at `checks:resolve`.
`explainer eval pace` runs only those lints on a spike or script/v1 file, with heard durations from `--timing`, appends their rows and prints items a minute per chapter, then the reused beats to re-voice when there are any.
To calibrate checks against labels, `LabelsSchema` parses a `labels/v1` labelled set (the v4 one is `fixtures/spike/redesign-explainer-v4/labels.json`) and
`calibrate` scores structure rows against it: precision and recall per check, with borderline labels counting as neither, and recall on the owner-named beats over error-severity rows.
`explainer eval calibrate` prints that report.
`explainer eval writing-calibrate` derives `doctrine/writing-check.json` from a corpus manifest: per-row AUC, human false-positive rate and status per length bucket, numbers only.
`explainer eval writing` scores a script against that table at the script's own length: per row its value, band, human standing, status, verdict and offending spans, exit 1 only when a gate row fails.
For a repo explainer, `gatherReview` reads a finished repo review (pinned clone, final label, `unread=0`) into a `review-bundle/v1` and schema-checked `ExplainerFact`s, tour kinds included (plus docs-skim and lifetime-history facts when the review has them), and refuses with coded diagnostics (`GATHER_CODES`) rather than throwing.
`renderCompanion` renders a repo run's companion doc (the martini-glass bowl) from those facts, one section per repo-tour block (`COMPANION_SECTIONS`), with each chapter's link into it and warnings rather than throws (`W-NO-SUMMARY`).
`companionChapters` maps script chapters to the blocks their spine rows play, so a digest cut links into the tour's doc; the script stage writes both as `companion` and `chapter-links`.
`enrichStructure` then adds the code structure: a `structure/v1` with repo-map levels, code-read centrality and reading order, entry points and code-graph call paths as map flows, and each fact's `centrality`, `reading_rank` and `module`.
When the review index has no snapshot at the pin, the fresh index covers only the files the review read (`reviewScopeFiles`, `scopedSource`), so a vendored tree is neither parsed nor opened by the type checker, and `W-INDEX-SCOPE` says so when no review file list exists and the whole clone is indexed.
For a PR video, `gatherPr` writes the pr-overview profile's `facts.jsonl` from the PR diff, its reviews and comments (through `gh`) and the code-graph calls between changed files at the head commit, with stable content-derived ids and coded refusals (`PR_GATHER_CODES`).
`explainer pr trigger` (`runPrVideoTrigger`, `autoBriefTargets`) starts a decision-brief run (the `gather` stage, then the audition;
with `--through script`, the script too, on the spine the audition writes from its pick, `pickSpine`, as pr-overview's `spine: { from: audition-pick }` declares)
only for PRs Shepherd holds at the owner's visual gate (`visual-gate2`) on a head still current right before the start, with `--dry-run`, and
`explainer pr gather` runs it on request.
For the daily briefing, `gatherDaily` reads one UTC day into a `digest.json` and a `facts.md` whose ids come from their sources
(PRs through `gh pr list`, sessions through `session-read`,
task deltas from `readTaskSnapshot`, which snapshots an active-work initiative read-only and reports tasks `opened`, `closed`, `moved` or `owner-gated` against the latest earlier snapshot).
`explainer run --facts-from gatherDaily --type daily-overview` starts a run from it
(as the run's `gather` stage with `--from gather`;
`gatherArticle` takes `--article` and `--claims`), and
`--dry-run` stops before any stage.
To make a whole video and see where its cost and time go, `explainer run` (`runVideo`) runs the `explainer-video` workflow:
an optional audition that writes `material-map.json` (deterministic signals from the facts and the fit predicates each structure reads, per profile; `--from audition --profile <type>`) and
`audition.json` (k spines from one verbalized-sampling call with stated likelihoods, each scored by code on fit, coverage, tension, range and freshness and by the reported-only cold-viewer rubric,
the agent's pick with its margin and runner-up, the profile's fixed order as the 0-candidate fallback, and no render),
script, rewrite, eval and TTS in process
(TTS: speech-tts Kokoro with strict words in the profile's voice band,
each beat calibrated to its speech band's words a minute from `doctrine/speech-bands.yaml`,
trued beat lengths,
`words.json` with absolute word times,
`voice.json`, and
a per-beat take cache),
then the render stage in process (`runRenderStage`: the template fill to a storyboard under beat-NN ids from `storyboardIds`, `compileTimeline`, the composition page with the style pack's CSS, `renderVideo` behind the run type's gate profile, a `duration-agreement` gate over the manifest and a reported `two-run` check, behind a `RenderEngine` seam),
then the qa stage in process (`runQaStage`: render-qa's gate at the cue moments and the 2 Hz sweep in Chromium behind a `QaEngine` seam, the `doctrine/qa/gate-profile.yaml` verdict through `loadQaGate`, the probe and framediff behind the motion-happened, clipped-text, content-fill and stage-empty checks, the DIRECTION timing gates of `timing-gates.ts` with thresholds from the type profile's `pacing`, render-qa's `mediaScan` behind the reported black-frames, silence-2s and frozen-frames checks, and `qa.json` as `explainer.qa/v1` with findings by beat and anchor),
then the sheets stage in process (`runSheetsStage`: ffprobe and ffmpeg through `ffmpegMedia`, `buildSidecar` for the theater's `video-meta@1` sidecar with an `explainer` block of video id, run ids, profile, script sha and fingerprint, and the poster),
`fingerprintOf` and `layoutKey` give each beat its `component/slots/anchors` layout key for the variety lints,
then a hard-linked export to the theater;
every stage but export is its own `explainer.<stage>` child workflow behind a stage cache keyed on the input shas it reads, its settings and variant file, and a sample index;
resolve builds each `layer: "custom"` beat's layer through claude-print by default, behind an esbuild compile gate and import allowlist, repairs a layer that fails the gate in one agent-chat round priced from the agent's transcript (when the host passes a repairer), and reuses an earlier run's build of an unchanged packet,
`explainer stage` runs one stage from stored shas,
`--from`/`--to`/`--pin` start and stop mid-pipeline,
`--budget-usd` is a resumable hard stop,
follow-up runs join the same video, and
`explainer run report [--compare <runId>]` writes `run-report.md` with per-stage wall time, usd, tokens, retries, cache hits, output shas and the video's linked-run total.
For an owner edit of a finished run, `SlotEditSchema` parses an `explainer.slot-edit/v1` (slot and tune fields per template beat, over a base run's script and render), and
`applyEdit` applies it to the base script, refusing a stale base, an unknown or custom-layer beat and a slot change that drops an element a cue targets, and returns the new script and a field diff.
`explainer edit check` prints that verdict with the slot-overrides gate, the template fill and the emphasis-target gate, and writes nothing,
`explainer edit apply [--start]` stores the script and the ledger row `<dataDir>/edits/<editId>.json` and launches the linked run from resolve (script and custom layers pinned, a $0.25 backstop), and
`explainer edit list` lists a render's or a video's edits with their linked run's status.
`explainer props --mp4-sha <sha>` reads the run that exported a render and gives each kept template beat its slot JSON Schema, filled value with overrides, overridden fields, cue-locked ids, span and still time, plus whether a save can change the render (it can, now render draws from the fill).
`compileTimeline` turns a storyboard and an optional words.json (its only reader) into the page's `timeline.json`: heard durations or planned ones with `provisional: true`, beat-local cue seconds for `word` or `word#n`, and slots parsed by `BEAT_SLOTS` until `@titan-design/beats` publishes; `writeTimeline` writes it as canonical JSON.
`renderVideo` renders a served `__titanMotion` page for a `RenderTimeline` through `@titan-design/frame-capture` to `<stem>.mp4` (H.264 + AAC), `captions.vtt` and `render-manifest.json`,
mixing narration with `mixAudio` or, with none, a sample-exact `silentMix` and `draft: true`.
`assertDurationAgreement` refuses a page and mix whose lengths differ by more than `DURATION_TOLERANCE_S`; `renderVideo` then deletes the mp4 and writes no manifest.
`renderVideo` with `qa: { mode: "gate" }` runs render-qa's cue-moment gate (`src/qa/cue-gate.ts`, shared with the qa stage) before mixing; held errors write `qa.json` and throw `QaRefused`, leaving no mix, mp4 or manifest.
`RenderManifestSchema` is `explainer.render-manifest/v1`: workers, frames, durations, draft, `qaGate` (`absent` with no `qa` option, `passed` with `qa: { heldErrors: 0, gateProfile }`, or `skipped`), a strict `RenderHostSchema` host with no hostname or paths (`collectRenderHost`), and the timeline, page, mix, mp4, vtt and words shas.
`toVtt` and `captionCues` write WebVTT from timed words (42 characters or 8 words a cue, broken at sentence ends, held 0.3 s).
