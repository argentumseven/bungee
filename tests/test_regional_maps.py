import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('regional_maps',Path(__file__).resolve().parents[1]/'scripts/regional_maps.py')
maps=importlib.util.module_from_spec(spec);spec.loader.exec_module(maps)

class RegionalMapsTests(unittest.TestCase):
    def test_map_plan_is_bounded_before_download(self):
        self.assertGreater(maps.archive_size('Extract transferred 3.0 GB (overfetch 0.05) for an archive size of 2.5 GB'),2_500_000_000)
        self.assertLess(maps.archive_size('archive size of 2.5 GB'),2_600_000_000)
        with self.assertRaises(ValueError):maps.archive_size('download failed')
    def test_only_compatible_daily_archives_can_be_selected(self):
        result=maps.current_build([{'key':'20261030.pmtiles','version':'4.0.1'},{'key':'../other.pmtiles','version':'5.0.0'},{'key':'20261031.pmtiles','version':'6.0.0'}])
        self.assertEqual(result['key'],'20261030.pmtiles')
        with self.assertRaises(ValueError):maps.current_build([])
