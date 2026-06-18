from __future__ import annotations

import os
from typing import Optional

from .config import settings


class R2Client:
    """Thin wrapper over the S3-compatible R2 API (boto3).

    GPU services read inputs (reference video, voice sample, avatar profile) and
    write outputs (audio, frames, finished mp4) to the same buckets the control
    plane manages. boto3 is imported lazily so the module can be imported in
    environments without it for unit tests.
    """

    def __init__(self) -> None:
        import boto3  # lazy

        self._s3 = boto3.client(
            "s3",
            endpoint_url=settings.r2_endpoint,
            aws_access_key_id=settings.r2_access_key_id,
            aws_secret_access_key=settings.r2_secret_access_key,
            region_name="auto",
        )

    def download(self, bucket: str, key: str, dest_path: str) -> str:
        os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
        self._s3.download_file(bucket, key, dest_path)
        return dest_path

    def upload(self, src_path: str, bucket: str, key: str, content_type: Optional[str] = None) -> str:
        extra = {"ContentType": content_type} if content_type else None
        self._s3.upload_file(src_path, bucket, key, ExtraArgs=extra)
        return key

    def upload_bytes(self, data: bytes, bucket: str, key: str, content_type: str) -> str:
        self._s3.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
        return key
