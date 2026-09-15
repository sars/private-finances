import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('frontend_assets', Path(__file__).resolve().parents[1] / 'deploy/frontend_assets.py')
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class AssetRetention(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def release(self, name):
        release = self.root / name
        directory = release / 'dist/frontend/assets'
        directory.mkdir(parents=True)
        (directory / f'{name}-abcdefgh.js').write_text(name)
        (release / 'dist/frontend/index.html').write_text(name + ' HTML')
        return release, directory

    def test_previous_native_only_and_rollback(self):
        a, aa = self.release('A')
        b, ba = self.release('B')
        c, ca = self.release('C')
        (aa / 'secret.json').write_text('not copied')
        (aa / 'plain.js').write_text('not fingerprinted')
        assets.retain_frontend_assets(b, a)
        assets.retain_frontend_assets(a, b)  # preflight rollback
        self.assertTrue((aa / 'B-abcdefgh.js').exists())
        self.assertTrue((ba / 'A-abcdefgh.js').exists())
        self.assertFalse((ba / 'secret.json').exists())
        self.assertFalse((ba / 'plain.js').exists())
        self.assertEqual((b / 'dist/frontend/index.html').read_text(), 'B HTML')
        assets.retain_frontend_assets(b, a)
        assets.retain_frontend_assets(c, b)
        self.assertTrue((ca / 'B-abcdefgh.js').exists())
        self.assertFalse((ca / 'A-abcdefgh.js').exists())
        assets.retain_frontend_assets(a, c)
        self.assertTrue((aa / 'C-abcdefgh.js').exists())
        self.assertFalse((aa / 'B-abcdefgh.js').exists())
        self.assertEqual((ca / 'B-abcdefgh.js').stat().st_mode & 0o777, 0o644)

    def test_collisions_fail_without_replacing_native(self):
        a, aa = self.release('A')
        b, ba = self.release('B')
        (aa / 'B-abcdefgh.js').write_text('different')
        with self.assertRaisesRegex(RuntimeError, 'collision'):
            assets.retain_frontend_assets(b, a)
        self.assertEqual((ba / 'B-abcdefgh.js').read_text(), 'B')
        self.assertFalse((ba / 'A-abcdefgh.js').exists())

    def test_symlinks_and_manifest_traversal_rejected(self):
        a, aa = self.release('A')
        b, _ = self.release('B')
        (aa / 'leak-abcdefgh.js').symlink_to(a / 'dist/frontend/index.html')
        with self.assertRaisesRegex(RuntimeError, 'invalid_frontend_asset'):
            assets.retain_frontend_assets(b, a)
        (aa / 'leak-abcdefgh.js').unlink()
        (a / assets.MANIFEST).write_text('{"native":{"../escape.js":"' + 'a'*64 + '"},"inherited":{}}')
        with self.assertRaisesRegex(RuntimeError, 'invalid_asset_manifest'):
            assets.retain_frontend_assets(b, a)

    def test_directory_symlink_and_byte_limits(self):
        a, aa = self.release('A')
        b, ba = self.release('B')
        ba.rename(ba.with_name('real-assets'))
        ba.symlink_to(ba.with_name('real-assets'), target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, 'asset_directory_symlink'):
            assets.retain_frontend_assets(b, a)
        ba.unlink()
        ba.with_name('real-assets').rename(ba)
        for key in ('MAX_TOTAL', 'MAX_FILE'):
            old = getattr(assets, key)
            try:
                setattr(assets, key, 0)
                with self.assertRaises(RuntimeError):
                    assets.retain_frontend_assets(b, a)
            finally:
                setattr(assets, key, old)

    def test_limits_and_changed_assets_rejected(self):
        a, aa = self.release('A')
        b, _ = self.release('B')
        assets.retain_frontend_assets(b, a)
        (aa / 'A-abcdefgh.js').write_text('tampered')
        with self.assertRaisesRegex(RuntimeError, 'frontend_assets_changed'):
            assets.retain_frontend_assets(b, a)
        c, _ = self.release('C')
        old = assets.MAX_FILES
        try:
            assets.MAX_FILES = 1
            with self.assertRaisesRegex(RuntimeError, 'frontend_asset_limit'):
                assets.retain_frontend_assets(b, c)
        finally:
            assets.MAX_FILES = old


if __name__ == '__main__':
    unittest.main()
