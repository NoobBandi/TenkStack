# The Python the agent runs code in. Built on this machine from the files
# beside this one; the tag is a hash of all of them, so a change here is a
# new image rather than a silently different old one.
FROM python:3.13-slim

# Noto CJK so a chart labelled in Chinese is drawn in Chinese; DejaVu is
# matplotlib's own and carries the Latin.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# The container has no network, so this list is everything there will ever
# be. It is the set a model reaches for in analysis and plotting, plus the
# readers for the file formats somebody asks to have written.
RUN pip install --no-cache-dir \
    numpy pandas scipy sympy mpmath statsmodels scikit-learn networkx \
    matplotlib seaborn pillow opencv-python-headless scikit-image \
    openpyxl xlsxwriter xlrd pyarrow tabulate \
    lxml beautifulsoup4 html5lib pyyaml jinja2 markdown \
    python-dateutil pytz tzdata regex chardet tqdm rich \
    shapely sqlalchemy python-docx python-pptx reportlab pypdf qrcode

RUN useradd --create-home --uid 1000 sandbox
COPY kernel.py client.py /opt/kernel/

# The font cache, built once here. $HOME is a tmpfs at run time, so the
# kernel copies this into it rather than matplotlib rebuilding it on every
# start -- which, with the CJK fonts, takes seconds.
ENV MPLBACKEND=agg PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN MPLCONFIGDIR=/opt/mpl python -c "import matplotlib.pyplot" && chmod -R a+rX /opt/mpl

USER sandbox
WORKDIR /home/sandbox
CMD ["python", "/opt/kernel/kernel.py"]
