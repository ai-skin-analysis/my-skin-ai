"""Production WSGI entry point.

Run this module only behind a TLS-terminating reverse proxy. The application
validates production environment variables on import, so a misconfigured
health-data deployment fails closed instead of serving requests.
"""

from app import app


application = app
