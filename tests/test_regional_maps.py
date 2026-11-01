import importlib.util
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

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
        for value in ({'error':'Forbidden'}, [None]):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError,'unexpected format'):
                maps.current_build(value)
    def test_forbidden_download_identifies_stage_without_redirect_query(self):
        error=HTTPError('https://download.example/map?temporary-token=private',403,'Forbidden',{},None)
        with patch.object(maps.urllib.request,'urlopen',side_effect=error) as fetch:
            with self.assertRaisesRegex(RuntimeError,'Street-map catalogue download: HTTP 403 from download.example/map') as result:
                maps.open_download(maps.CATALOG_URL,'Street-map catalogue download',timeout=60)
        self.assertNotIn('temporary-token',str(result.exception))
        request=fetch.call_args.args[0]
        self.assertEqual(request.get_header('User-agent'),'Bungee map installer')
        self.assertEqual(fetch.call_args.kwargs['timeout'],60)
    def test_network_failure_identifies_host_and_preserves_data(self):
        with patch.object(maps.urllib.request,'urlopen',side_effect=URLError('connection refused')):
            with self.assertRaisesRegex(RuntimeError,'Map extraction tool download: could not reach github.com'):
                maps.open_download('https://github.com/tool','Map extraction tool download')
    def test_forbidden_tool_download_creates_no_destination(self):
        error=HTTPError('https://github.com/tool',403,'Forbidden',{},None)
        with tempfile.TemporaryDirectory() as directory, patch.object(maps.urllib.request,'urlopen',side_effect=error):
            target=Path(directory)/'tool.tar.gz'
            with self.assertRaisesRegex(RuntimeError,'Map extraction tool download: HTTP 403'):
                maps.download('https://github.com/tool',target,1024)
            self.assertFalse(target.exists())
    def test_tool_download_retains_checksum_and_byte_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'tool.tar.gz'
            with patch.object(maps,'open_download',return_value=io.BytesIO(b'verified tool')):
                self.assertEqual(maps.download('https://github.com/tool',target,1024),hashlib.sha256(b'verified tool').hexdigest())
            with patch.object(maps,'open_download',return_value=io.BytesIO(b'too large')):
                with self.assertRaisesRegex(ValueError,'size limit'):
                    maps.download('https://github.com/tool',Path(directory)/'oversized',3)
