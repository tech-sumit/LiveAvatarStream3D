# realtime: streaming STT -> director LLM DSL -> streaming TTS -> talking-head -> NVENC -> WHIP
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg git && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/gpu/common /opt/las_common
RUN pip3 install --no-cache-dir /opt/las_common
COPY services/gpu/realtime/requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
COPY services/gpu/realtime/ .

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
