from pathlib import Path
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]
LANDING_TEMPLATE = PROJECT_ROOT / 'templates' / 'landing.html'


class LandingLoadingResilienceTests(unittest.TestCase):
    def test_optional_external_presentation_scripts_do_not_block_html_parsing(self):
        template = LANDING_TEMPLATE.read_text(encoding='utf-8')

        self.assertIn('src="https://cdn.tailwindcss.com" defer', template)
        self.assertIn('src="https://unpkg.com/lucide@latest" defer', template)


if __name__ == '__main__':
    unittest.main()
