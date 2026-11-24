FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    YOLO_CONFIG_DIR=/tmp/Ultralytics

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 tzdata \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt download_models.py ./
RUN pip install --no-cache-dir -r requirements.txt && python download_models.py

# Body (person) tracking: CPU-only PyTorch + Ultralytics YOLOv8n.
# ultralytics pulls in the GUI opencv-python, which clashes with opencv-python-headless, so swap it back.
RUN pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir ultralytics==8.3.40 \
    && pip uninstall -y opencv-python \
    && pip install --no-cache-dir --force-reinstall --no-deps opencv-python-headless==4.11.0.86 \
    && python -c "import urllib.request; urllib.request.urlretrieve('https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8n.pt', 'models/yolov8n.pt')" \
    && python -c "from ultralytics import YOLO; import cv2; YOLO('models/yolov8n.pt'); print('YOLO ok, cv2', cv2.__version__)"

COPY src/ ./src/

EXPOSE 8000

CMD ["uvicorn", "main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000"]
