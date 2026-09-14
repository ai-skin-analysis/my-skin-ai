# Multi-class training data

Do not place unlicensed or user-uploaded production images in this directory.

Create the complete 50-class folder structure and safe templates with:

```powershell
.\.venv\Scripts\python.exe prepare_multiclass_dataset.py --scaffold
```

This command creates empty folders, `class_mapping.csv`, and
`dataset_manifest.template.json`. It does **not** make the dataset approved or
ready to train. After data governance approves the source and labels, complete
the template as `dataset_manifest.json` and run the preflight report again.

Before training, hash the entire dataset to catch duplicated content:

```powershell
.\.venv\Scripts\python.exe prepare_multiclass_dataset.py --check-duplicates
```

`train_multiclass.py` expects folders named with the `id` values in
[`disease_catalog.json`](../../disease_catalog.json), for example:

```text
dataset/multiclass/
  acne_vulgaris/
  atopic_dermatitis/
  melanoma/
  ...
```

The trainer rejects every selected class with fewer than 200 images. Keep a
patient/lesion-disjoint held-out test set outside this directory; the automatic
validation split is not a substitute for clinical evaluation.
