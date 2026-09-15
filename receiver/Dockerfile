FROM python:3.13.7-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY bridge.py .
ENV PYTHONUNBUFFERED=1
CMD ["python", "bridge.py"]
