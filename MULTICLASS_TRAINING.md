# Expanding to 50 screening classes

The bundled model supports only these six labels: Actinic keratoses, Basal cell
carcinoma, Benign keratosis, Dermatofibroma, Melanoma, and Vascular lesions.
The 50-class target is defined in [`disease_catalog.json`](disease_catalog.json),
but its additional labels are **not enabled** until a matching model and metadata
file are trained and evaluated.

Each catalog item has a stable folder `id`, a Thai display name (`name_th`), and
an explicit English name (`name_en`). The model's metadata uses the canonical
English `label`, so do not rename a label after collecting training images.

## Required data provenance manifest

Every training directory must contain `dataset_manifest.json`. The trainer now
rejects a dataset unless the manifest records an approved dataset ID, source,
licence, approval record, and every included class ID. It also hashes every
image and rejects duplicate content across the selected classes. This prevents
the same photograph being copied into different diagnoses or across a split.

```json
{
  "schema_version": 1,
  "dataset_id": "approved-clinical-set-2026-01",
  "source": "<approved source URL or identifier>",
  "license": "<approved licence or DUA>",
  "approval_record": "<ethics/DUA reference>",
  "approved_for_training": true,
  "class_ids": ["acne_vulgaris", "atopic_dermatitis"]
}
```

## Why this is necessary

Adding a label in HTML or Python cannot teach a model how to distinguish it.
Conditions such as dermatitis, fungal infection, psoriasis, and drug reactions
can look similar in a photograph. The system therefore records the top three
model scores and withholds a label when either the leading score or its gap from
the runner-up is too small. This is a screening safeguard, not a diagnostic
measure.

## ภาพที่ไม่มีโรคอยู่ในระบบ

เมื่อคะแนนของทุกกลุ่มที่โมเดลรองรับต่ำกว่าค่าที่กำหนด แอปจะแสดงว่า
"ไม่พบกลุ่มที่ใกล้เคียงเพียงพอในโมเดล" พร้อมคะแนนสามกลุ่มที่ใช้เปรียบเทียบ
เท่านั้น ค่านี้ช่วยหยุดการฝืนตั้งชื่อโรคจาก label ที่ไม่มีในโมเดล แต่ **ไม่ได้
ระบุชื่อโรคใหม่** และไม่ได้พิสูจน์ว่าเป็นโรคที่อยู่นอกระบบ เพราะโมเดลอาจมั่นใจผิด
กับภาพนอกข้อมูลฝึกได้

หากต้องการให้รู้จักกลุ่ม "อื่น/ไม่อยู่ในรายการ" ต้องเก็บภาพ clinical ที่มีฉลาก
ยืนยันของทั้งโรคที่รองรับและโรค/สภาพผิวที่อยู่นอกขอบเขต แยกชุดทดสอบสำหรับ
open-set/OOD calibration แล้วกำหนด `--out-of-scope-threshold` จากผลทดสอบ
ภายใต้การทบทวนของแพทย์ก่อนนำขึ้นใช้งานจริง ห้ามใช้ภาพที่ผู้ใช้อัปโหลดเป็นข้อมูล
ฝึกโดยไม่มีสิทธิและการยินยอมที่ถูกต้อง

## Approved-data checklist

1. Obtain and document permission for every dataset. Do not scrape images from
   medical websites or mix patient uploads into training data.
2. Map every source label to exactly one `id` in `disease_catalog.json`; have a
   dermatologist review the mapping and ambiguous images.
3. Keep dermoscopic lesion images and ordinary clinical photos separate. The
   trainer rejects mixed modalities unless `--allow-mixed-domains` is explicitly
   supplied after validation.
4. Use patient/lesion-disjoint train, validation, and independent test splits.
   The trainer's image-level validation split is not a clinical test set.
5. Review per-class recall, calibration, confidence intervals, and the confusion
   matrix before replacing the production model.

Useful documented sources to evaluate under their own terms:

- ISIC challenge datasets: lesion-focused, with licenses varying by release.
- SCIN: common dermatology images under the SCIN Data Use License.
- Fitzpatrick17k: 114 conditions, but images require access and are
  CC BY-NC-SA 3.0.

## Dataset layout

Create a local, licensed dataset using the catalog `id` names:

```text
dataset/multiclass/
  actinic_keratosis/
  acne_vulgaris/
  atopic_dermatitis/
  ...
```

Each selected class needs at least 200 images by default. This is only a guard
against an obviously invalid training run; it is not a claim that 200 images per
class is sufficient for clinical deployment.

The Admin dashboard may start a **research candidate** with a separate floor of
five labelled images per class. This lower floor exists only to validate the
training workflow and produce a development artifact; it is not suitable for
clinical evaluation or deployment. The production release requirements remain
unchanged.

## Train

For a clinically photographed-condition model:

```powershell
.\.venv\Scripts\python.exe train_multiclass.py `
  --data-dir dataset\multiclass `
  --group clinical `
  --dataset-source "<approved source URL or identifier>" `
  --dataset-license "<approved license or DUA>"
```

The script writes the model, `.metadata.json`, `.evaluation.json`, and a
`.independent-evaluation.template.json` next to the requested output. The web
app reads the metadata class order automatically; do not manually edit it. A
newly trained artifact is **not deployable**: its metadata deliberately records
no independent evaluation, calibration, or clinical deployment approval. Those
records must be completed by a controlled release process before a production
app will accept health images.

To train all 50 labels in one model, an explicit `--group all
--allow-mixed-domains` is required. That flag exists for controlled research
only: it must not be used merely to make the class count larger.

## Independent-evaluation evidence package

The generated `.independent-evaluation.template.json` is intentionally
incomplete. It is bound to the candidate model's exact output order, artifact
hash, metadata hash, thresholds, and input domains so a reviewer cannot quietly
replace a class, metric, or artifact after evaluation.

Complete a copy of that template only from a genuinely independent evaluation.
It requires:

1. Evaluation-dataset provenance and the SHA-256 of its approved manifest.
2. A reviewer-attested patient/lesion-disjoint split with a digest of the split
   manifest. A script cannot prove disjointness without protected patient data.
3. Per-class support, recall, precision, and 95% recall confidence intervals
   for every model output, plus the same metrics for each supported input
   domain.
4. Calibration evidence tied to all three deployed thresholds, and a separate
   approved OOD dataset with false-acceptance rate and 95% interval.
5. Intended-use and human release-review references.

Validate the completed evidence against the exact candidate artifact before a
human release review:

```powershell
.\.venv\Scripts\python.exe validate_model_evaluation.py `
  --model models\candidate-50.h5 `
  --metadata models\candidate-50.metadata.json `
  --evaluation-manifest models\candidate-50.independent-evaluation.json `
  --output models\candidate-50.evidence-report.json
```

The command exits non-zero on a missing or inconsistent field and never writes
to the model metadata, changes the production gate, activates classes, or
establishes clinical validity. A structurally valid evidence report still needs
the independent human/clinical review required by `MODEL_50_CLASS_RELEASE.md`.

## Archive candidate mapping provenance

`map_archive_dataset.py` now records SHA-256 digests for `archive.zip`, its
mapping rules, catalog, and generated mapping CSV. These digests make a mapping
review traceable to one exact input set; they do not turn filename candidates
into approved medical labels. Re-run the mapper after either the archive, rules,
or catalog changes and obtain the required reviewer decisions before extraction
or training.
