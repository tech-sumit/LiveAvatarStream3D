from setuptools import setup, find_packages

setup(
    name="las_common",
    version="0.0.0",
    packages=find_packages(),
    install_requires=["boto3>=1.34", "httpx>=0.27"],
    python_requires=">=3.10",
)
