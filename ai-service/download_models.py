"""Download the OpenCV model-zoo face models into ./models (run once; ~39 MB)."""

import hashlib
import sys
import urllib.request
from pathlib import Path

BASE = "https://github.com/opencv/opencv_zoo/raw/main/models"
MODELS = {
    "face_detection_yunet_2023mar.onnx": f"{BASE}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx": f"{BASE}/face_recognition_sface/face_recognition_sface_2021dec.onnx",
}

out_dir = Path(__file__).resolve().parent / "models"
out_dir.mkdir(exist_ok=True)

for name, url in MODELS.items():
    dest = out_dir / name
    if dest.exists() and dest.stat().st_size > 100_000:
        print(f"ok        {name}")
        continue
    print(f"download  {name}")
    try:
        urllib.request.urlretrieve(url, dest)
    except Exception as exc:
        sys.exit(f"Failed to download {name}: {exc}")
    print(f"          sha256 {hashlib.sha256(dest.read_bytes()).hexdigest()[:16]}…")
