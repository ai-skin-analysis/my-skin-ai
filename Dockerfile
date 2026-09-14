# Public-information Cloud Run image.  The application deliberately disables
# accounts, uploads, and analysis unless a separately approved private-data
# release is configured.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# TensorFlow needs the OpenMP runtime.  Keep the OS image minimal and do not
# install build tools or place runtime data in the container image.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . ./

ENV PORT=8080
EXPOSE 8080

# One worker avoids duplicate TensorFlow model loading. Cloud Run scales
# instances horizontally; its runtime injects the PORT value.
CMD ["sh", "-c", "exec gunicorn --bind 0.0.0.0:${PORT:-8080} --workers 1 --threads 4 --timeout 120 --access-logfile - --error-logfile - wsgi:application"]
