"""
PDF text + table extractor using pdfplumber.
Called by Google Apps Script to parse PoolCorp invoices and order acknowledgements.
Returns structured table data (list-of-lists per page) + raw text fallback.

Auth: POST body must include { "secret": "<PARSE_PDF_SECRET env var>" }
Body: { "secret": "...", "pdf_base64": "<base64-encoded PDF bytes>" }
"""

from http.server import BaseHTTPRequestHandler
import pdfplumber
import base64
import tempfile
import os
import json


class handler(BaseHTTPRequestHandler):

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body   = json.loads(self.rfile.read(length))
        except Exception:
            self._respond(400, {"ok": False, "error": "Invalid JSON body"})
            return

        expected_secret = os.environ.get("PARSE_PDF_SECRET", "")
        if not expected_secret or body.get("secret", "") != expected_secret:
            self._respond(401, {"ok": False, "error": "Unauthorized"})
            return

        pdf_b64 = body.get("pdf_base64", "")
        if not pdf_b64:
            self._respond(400, {"ok": False, "error": "pdf_base64 is required"})
            return

        try:
            pdf_bytes = base64.b64decode(pdf_b64)
        except Exception:
            self._respond(400, {"ok": False, "error": "pdf_base64 is not valid base64"})
            return

        tmp_path = None
        try:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
                f.write(pdf_bytes)
                tmp_path = f.name

            pages  = []
            texts  = []

            with pdfplumber.open(tmp_path) as pdf:
                for page in pdf.pages:
                    raw_text = page.extract_text() or ""
                    texts.append(raw_text)

                    # extract_tables returns list[list[list[str|None]]]
                    raw_tables = page.extract_tables() or []

                    # Normalise None → "" for easy JSON / GAS handling
                    clean_tables = [
                        [
                            [cell if cell is not None else "" for cell in row]
                            for row in table
                        ]
                        for table in raw_tables
                    ]

                    pages.append({"text": raw_text, "tables": clean_tables})

            self._respond(200, {
                "ok"    : True,
                "text"  : "\n".join(texts),   # full raw text (all pages)
                "pages" : pages                # per-page structured tables
            })

        except Exception as e:
            self._respond(500, {"ok": False, "error": str(e)})
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

    def do_GET(self):
        self._respond(200, {"ok": True, "message": "PDF parser — POST only"})

    def _respond(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # suppress default request logging
