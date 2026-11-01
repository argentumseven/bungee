import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('host', Path(__file__).resolve().parents[1] / 'scripts/bungee-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)


class BasemapTests(unittest.TestCase):
    def test_bundled_map_is_checksummed_real_global_raster_coverage(self):
        path = host.default_basemap()
        with sqlite3.connect(f'file:{path}?mode=ro', uri=True) as db:
            metadata = dict(db.execute('SELECT name,value FROM metadata'))
            self.assertEqual(metadata['bungee_map_kind'], 'overview')
            self.assertIn('Natural Earth', metadata['attribution'])
            for zoom in range(7):
                self.assertEqual(db.execute('SELECT COUNT(*) FROM tiles WHERE zoom_level=?', [zoom]).fetchone()[0], 4**zoom)
            self.assertTrue(db.execute('SELECT tile_data FROM tiles WHERE zoom_level=0').fetchone()[0].startswith(b'\x89PNG\r\n\x1a\n'))

    def test_new_installation_pins_default_map_without_provider_access(self):
        with tempfile.TemporaryDirectory() as directory:
            instance = host.Host(Path(directory))
            from test_host import CONFIG, metadata
            generation = instance.stage(CONFIG, metadata())
            self.assertTrue((instance.root / 'datasets/empty/map.mbtiles').is_file())
            self.assertIn('datasets/empty', (instance.root / 'generations' / generation / 'compose.json').read_text())
            with patch.object(instance, 'datasets') as datasets:
                host.atomic(instance.root / 'current.json', {'generation':generation})
                host.install_basemap(instance)
                datasets.assert_not_called()

    def test_existing_custom_map_is_never_overwritten_by_default_command(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            host.atomic(root/'current.json', {'generation':'a'*24})
            host.atomic(root/'generations'/('a'*24)/'config.json', {'geodata':'b'*24})
            dataset = root/'datasets'/('b'*24)/'map.mbtiles'
            dataset.parent.mkdir(parents=True)
            dataset.write_bytes(b'existing regional archive')
            instance = host.Host(root)
            with patch.object(instance,'datasets') as import_data, self.assertRaises(ValueError):
                host.install_basemap(instance)
            import_data.assert_not_called()
            self.assertEqual(dataset.read_bytes(), b'existing regional archive')

    def test_existing_server_without_a_map_can_import_it_transactionally(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            host.atomic(root/'current.json', {'generation':'a'*24})
            host.atomic(root/'generations'/('a'*24)/'config.json', {})
            instance = host.Host(root)
            with patch.object(instance,'datasets') as import_data:
                host.install_basemap(instance)
            import_data.assert_called_once_with(maps=host.default_basemap())


if __name__ == '__main__': unittest.main()
