# Six-label research scope

The new dashboard requires an authenticated runtime whose version matches
`pad6-local-[0-9a-f]{12}` and whose class count is exactly six. It will not
upload a photo to an old twenty-label runtime or silently relabel its scores.
The server transport pins the exact deployed version using the existing
`SMART_SKIN_INFERENCE_VERSION` configuration.

PAD labels, in model order: actinic keratosis, basal cell carcinoma, melanoma,
melanocytic nevus, squamous cell carcinoma, seborrheic keratosis.
This is one six-label classifier, not six models or six training images.

Legacy stored results retain their original twenty-label catalogue and warning.
Six-label results never reuse the old 112/338 metric or claim external clinical
validation. Uncertain results remain abstentions; two score-ranked labels are
educational information only, not diagnoses or matched training photos.

Completion now first opens a neutral completed-processing dialog. Only its
result button opens the owner-facing AI analysis screen, without submitting
another inference request. A new consent version describes the changed scope.

The existing public release gate, account approval, consent, same-origin/session
checks, private-storage ownership checks, retention, server-only credentials,
and clinician-replacement disclaimer remain intact.

The first six-label patient-held-out study produced 53.4% image accuracy and
52.0% macro recall. The validation confidence policy was not met. It is **not**
a public-release pass. Source: PAD-UFES-20 V1 (CC BY 4.0), 2,298 images.
https://data.mendeley.com/datasets/zr7vgbcyr2/1

Local verification: 91 JavaScript tests passed, including legacy compatibility,
strict six-label/version mapping, upload/camera completion, abstention, and
private-storage/authentication failure paths. A UI fixture is explicitly
labelled simulated and does not call a model or upload a patient image.
