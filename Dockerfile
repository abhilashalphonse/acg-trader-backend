FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 ACG_DATA_DIR=/data
COPY . /app
RUN python work/accept_cloud_runtime.py && python work/test_accept01.py && python work/test_state01.py && python work/test_accept_cloud_runtime.py
CMD ["python", "work/accept_cloud_runtime.py", "--serve"]
