import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
import map_manager as maps
import regional_maps

class MapManagerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);maps.setup(self.root)
        self.catalog=self.root/'regions.json'
        self.regions=[{'id':identifier,'name':identifier,'group':'Synthetic','bounds':[-81,32,-79,34],
                       'estimated_bytes':1024,'max_zoom':15,'geometry':{'type':'Polygon','coordinates':[[[-81,32],[-79,32],[-79,34],[-81,32]]]}}
                      for identifier in ('test-one','test-two')]
        self.catalog.write_text(json.dumps({'format':1,'regions':self.regions}))
        self.disk={'total_bytes':16*maps.GIB,'free_bytes':8*maps.GIB,'reserve_bytes':3*maps.GIB,
                   'available_bytes':5*maps.GIB,'backing_has_tool_space':True}
        self.capacity=patch.object(maps,'capacity',return_value=self.disk);self.capacity.start();self.addCleanup(self.capacity.stop)
    def plan(self,identifier='test-one',size=1024):
        item=next(item for item in self.regions if item['id']==identifier)
        entry={key:item[key] for key in ('id','name','group','bounds','max_zoom')}|{'planned_bytes':size}
        return {'build':'20261031.pmtiles','created_at':int(time.time()),'regions':[entry],'planned_bytes':size}
    def extracted(self,catalog,plan,staging,progress,available,cancelled,completed=None):
        if cancelled():raise regional_maps.MapCancelled('Map operation stopped; completed maps remain downloaded')
        results=[]
        for item in plan['regions']:
            header=bytearray(127);header[:8]=b'PMTiles\x03';header[97]=2;header[98]=1;header[99]=1;header[101]=15
            data=bytes(header)+b'synthetic validated output'
            path=Path(staging)/(item['id']+'.pmtiles');path.write_bytes(data)
            results.append({key:item[key] for key in ('id','name','group','bounds','max_zoom')}|
                           {'path':str(path),'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'build':plan['build']})
            if completed: completed(results[-1])
        return results
    def request(self,action,regions,plan_id=None):
        identifier=str(uuid.uuid4());path=self.root/'map-control/requests'/(identifier+'.json')
        path.write_text(json.dumps({'action':action,'regions':regions,'plan_id':plan_id}));return identifier,path
    def state(self):return json.loads((self.root/'map-control/status/state.json').read_text())
    def test_worker_umask_keeps_public_metadata_readable_and_private_requests_private(self):
        previous=os.umask(0o077)
        try:
            maps.atomic(self.root/'maps/library.json',{'format':1,'regions':[]})
            maps.public_status(self.root,self.catalog,{})
            identifier,path=self.request('plan',['test-one'])
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            for relative in ('maps/library.json','map-control/status/state.json'):
                self.assertEqual((self.root/relative).stat().st_mode&0o777,0o644)
            self.assertEqual((self.root/'map-control/requests').stat().st_mode&0o777,0o700)
        finally: os.umask(previous)
    def test_setup_repairs_old_public_metadata_without_changing_private_data(self):
        maps.public_status(self.root,self.catalog,{})
        originals={}
        for relative in ('maps/library.json','map-control/status/state.json'):
            path=self.root/relative;originals[relative]=path.read_bytes();path.chmod(0o600)
        private=self.root/'private-key';private.write_text('test-only-secret');private.chmod(0o600)
        maps.setup(self.root)
        for relative,data in originals.items():
            path=self.root/relative
            self.assertEqual(path.read_bytes(),data);self.assertEqual(path.stat().st_mode&0o777,0o644)
        self.assertEqual(private.stat().st_mode&0o777,0o600)
    def test_metadata_repair_refuses_symlinks_and_hardlinks_without_exposing_the_target(self):
        path=self.root/'maps/library.json';path.unlink()
        private=self.root/'private-key';private.write_text('test-only-secret');private.chmod(0o600)
        path.symlink_to(private)
        with self.assertRaises(OSError):maps.setup(self.root)
        path.unlink();os.link(private,path)
        with self.assertRaises(ValueError):maps.setup(self.root)
        self.assertEqual(private.stat().st_mode&0o777,0o600)
    def test_regions_are_allowlisted_and_duplicate_or_nontext_ids_are_refused(self):
        catalog=regional_maps.region_catalog(self.catalog)
        for selection in (['../outside'],['test-one','test-one'],[{}],[],['test-one']*25):
            with self.subTest(selection=selection),self.assertRaises(ValueError):regional_maps.selection(catalog,selection)
    def test_size_and_installed_total_are_checked_before_extraction(self):
        with patch.object(regional_maps,'extract_regions') as extract:
            with self.assertRaisesRegex(ValueError,'safe free space'):maps.install_plan(self.root,self.catalog,self.plan(size=6*maps.GIB),lambda _:None)
            extract.assert_not_called()
        maps.atomic(self.root/'maps/library.json',{'format':1,'regions':[{'id':'old','bytes':24_999_999_999}]})
        with self.assertRaisesRegex(ValueError,'25 GB'):maps.check_plan(self.root,self.plan())
    def test_host_swap_growth_headroom_also_blocks_an_unsafe_download(self):
        with patch.object(maps,'capacity',return_value={**self.disk,'backing_has_tool_space':False}):
            with self.assertRaisesRegex(ValueError,'safe free space'):maps.check_plan(self.root,self.plan())
    def test_low_space_blocks_tool_downloads_before_planning(self):
        with patch.object(maps,'capacity',return_value={**self.disk,'available_bytes':0}),patch.object(regional_maps,'make_plan') as plan:
            with self.assertRaisesRegex(ValueError,'even for map planning'):maps.plan_selection(self.root,self.catalog,['test-one'],lambda _:None)
            plan.assert_not_called()
    def test_installed_region_count_is_bounded(self):
        maps.atomic(self.root/'maps/library.json',{'format':1,'regions':[{'id':str(n),'bytes':1} for n in range(regional_maps.MAX_REGIONS)]})
        with self.assertRaisesRegex(ValueError,'region limit'):maps.check_plan(self.root,self.plan())
    def test_verified_archives_are_published_by_rename_and_report_actual_size(self):
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):maps.install_plan(self.root,self.catalog,self.plan(),lambda _:None)
        item=maps.library(self.root)['regions'][0];target=self.root/'maps/archives'/item['filename']
        self.assertTrue(target.exists());self.assertEqual(target.stat().st_size,item['bytes']);self.assertEqual(target.stat().st_mode&0o777,0o644)
        self.assertEqual(list((self.root/'maps').glob('.staging-*')),[])
    def test_provider_failure_preserves_all_existing_maps(self):
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):maps.install_plan(self.root,self.catalog,self.plan(),lambda _:None)
        before=maps.library(self.root)
        with patch.object(regional_maps,'extract_regions',side_effect=RuntimeError('HTTP 403')):
            with self.assertRaisesRegex(RuntimeError,'403'):maps.install_plan(self.root,self.catalog,self.plan('test-two'),lambda _:None)
        self.assertEqual(maps.library(self.root),before);self.assertEqual(len(list((self.root/'maps/archives').iterdir())),1)
    def test_bad_archive_never_enters_the_library(self):
        def bad(*args):
            def invalid(item):
                Path(item['path']).write_bytes(b'not PMTiles');args[-1](item)
            return self.extracted(*args[:-1],invalid)
        with patch.object(regional_maps,'extract_regions',side_effect=bad):
            with self.assertRaisesRegex(ValueError,'street-level'):maps.install_plan(self.root,self.catalog,self.plan(),lambda _:None)
        self.assertEqual(maps.library(self.root)['regions'],[]);self.assertEqual(list((self.root/'maps/archives').iterdir()),[])
    def test_removal_keeps_other_maps_and_saved_history(self):
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):
            maps.install_plan(self.root,self.catalog,self.plan(),lambda _:None)
            maps.install_plan(self.root,self.catalog,self.plan('test-two'),lambda _:None)
        history=self.root/'saved-history';history.write_text('preserve')
        maps.remove_regions(self.root,['test-one'])
        self.assertEqual([item['id'] for item in maps.library(self.root)['regions']],['test-two']);self.assertEqual(history.read_text(),'preserve')
    def test_stopping_a_batch_keeps_completed_pieces_and_a_new_plan_only_downloads_the_remainder(self):
        plan=self.plan();plan['regions']+=self.plan('test-two')['regions'];plan['planned_bytes']=2048;plan['id']=str(uuid.uuid4())
        maps.public_status(self.root,self.catalog,{'last_plan':plan})
        self.request('install',['test-one','test-two'],plan['id'])
        def stopped(catalog,plan,staging,progress,available,cancelled,completed):
            self.extracted(catalog,{**plan,'regions':plan['regions'][:1]},staging,progress,available,cancelled,completed)
            raise regional_maps.MapCancelled('stopped after first piece')
        with patch.object(regional_maps,'extract_regions',side_effect=stopped):maps.tick(self.root,self.catalog)
        self.assertEqual(self.state()['job']['state'],'canceled')
        self.assertEqual(self.state()['job']['completed'],1);self.assertEqual(self.state()['job']['total'],2)
        self.assertEqual([item['id'] for item in maps.library(self.root)['regions']],['test-one'])
        with patch.object(regional_maps,'make_plan',return_value=self.plan('test-two')) as planning:
            maps.plan_selection(self.root,self.catalog,['test-one','test-two'],lambda _:None)
        self.assertEqual(planning.call_args.args[1],['test-two'])
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):maps.install_plan(self.root,self.catalog,self.plan('test-two'),lambda _:None)
        self.assertEqual(len(maps.library(self.root)['regions']),2)
    def test_downloaded_regions_can_be_deleted_even_after_leaving_the_catalogue(self):
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):maps.install_plan(self.root,self.catalog,self.plan(),lambda _:None)
        self.catalog.write_text(json.dumps({'format':1,'regions':[self.regions[1]]}))
        self.request('remove',['test-one']);maps.tick(self.root,self.catalog)
        self.assertEqual(self.state()['job']['state'],'completed');self.assertEqual(maps.library(self.root)['regions'],[])
    def test_restart_reclaims_only_unreferenced_generated_archives(self):
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):maps.install_plan(self.root,self.catalog,self.plan(),lambda _:None)
        orphan=self.root/'maps/archives/test-two-0123456789abcdef.pmtiles';orphan.write_bytes(b'interrupted unpublished file')
        other=self.root/'maps/archives/operator-notes.txt';other.write_text('keep')
        maps.tick(self.root,self.catalog)
        self.assertFalse(orphan.exists());self.assertTrue(other.exists())
        self.assertEqual(len(list((self.root/'maps/archives').glob('*.pmtiles'))),1)
    def test_request_symlinks_hardlinks_and_fifos_are_rejected(self):
        original=self.root/'original';original.write_text('{}')
        link=self.root/'link';link.symlink_to(original)
        with self.assertRaises(OSError):maps.read_request(link)
        hard=self.root/'hard';os.link(original,hard)
        with self.assertRaises(ValueError):maps.read_request(hard)
        fifo=self.root/'fifo';os.mkfifo(fifo)
        with self.assertRaises(ValueError):maps.read_request(fifo)
        self.assertEqual(original.read_text(),'{}')
    def test_request_cannot_supply_a_url_command_or_local_file(self):
        identifier,path=self.request('install',['test-one']);value=json.loads(path.read_text());value['url']='https://example.invalid/private';path.write_text(json.dumps(value))
        maps.tick(self.root,self.catalog)
        self.assertEqual(self.state()['job']['state'],'failed');self.assertEqual(maps.library(self.root)['regions'],[]);self.assertFalse(path.exists())
    def test_plan_then_explicit_install_uses_the_reviewed_selection(self):
        identifier,path=self.request('plan',['test-one'])
        with patch.object(regional_maps,'make_plan',return_value=self.plan()):maps.tick(self.root,self.catalog)
        self.assertEqual(self.state()['last_plan']['id'],identifier);self.assertFalse(path.exists());self.assertEqual(maps.library(self.root)['regions'],[])
        self.request('install',['test-one'],identifier)
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):maps.tick(self.root,self.catalog)
        self.assertEqual(self.state()['job']['state'],'completed');self.assertEqual(len(maps.library(self.root)['regions']),1)
    def test_expired_or_changed_plan_is_not_downloaded(self):
        plan=self.plan()|{'id':str(uuid.uuid4()),'created_at':int(time.time())-3601}
        maps.public_status(self.root,self.catalog,{'last_plan':plan})
        self.request('install',['test-one'],plan['id'])
        with patch.object(regional_maps,'extract_regions') as extract:maps.tick(self.root,self.catalog);extract.assert_not_called()
        self.assertEqual(self.state()['job']['state'],'failed');self.assertIn('expired',self.state()['job']['message'])
    def test_worker_restart_cleans_only_abandoned_staging_and_marks_job_failed(self):
        stage=self.root/'maps/.staging-abandoned';stage.mkdir();(stage/'partial.pmtiles').write_bytes(b'partial')
        keep=self.root/'maps/keep';keep.write_text('keep')
        maps.public_status(self.root,self.catalog,{'job':{'id':str(uuid.uuid4()),'state':'running'}})
        maps.tick(self.root,self.catalog)
        self.assertFalse(stage.exists());self.assertTrue(keep.exists());self.assertEqual(self.state()['job']['state'],'failed')
    def test_cancel_discards_staging_without_touching_installed_data(self):
        plan=self.plan()|{'id':str(uuid.uuid4())};maps.public_status(self.root,self.catalog,{'last_plan':plan})
        identifier,_=self.request('install',['test-one'],plan['id']);(self.root/'map-control/requests'/('cancel-'+identifier)).touch()
        with patch.object(regional_maps,'extract_regions',side_effect=self.extracted):maps.tick(self.root,self.catalog)
        self.assertEqual(self.state()['job']['state'],'canceled');self.assertEqual(maps.library(self.root)['regions'],[])
    def test_capacity_counts_existing_swap_once_and_exposes_growth_reserve(self):
        self.capacity.stop()
        try:
            with patch.object(maps,'free_bytes',return_value=(8*maps.GIB,16*maps.GIB)),patch.object(Path,'read_text',return_value='SwapTotal: 1048576 kB\nSwapFree: 524288 kB\n'):
                disk=maps.capacity(self.root)
            self.assertEqual(disk['swap_total_bytes'],maps.GIB);self.assertEqual(disk['swap_used_bytes'],maps.GIB//2)
            self.assertEqual(disk['swap_growth_reserve_bytes'],2*maps.GIB);self.assertGreater(disk['reserve_bytes'],0)
        finally:self.capacity.start()
    def test_installer_checklist_toggles_choices_and_displays_combined_sizes(self):
        spec=importlib.util.spec_from_file_location('map_wizard_host',Path(__file__).resolve().parents[1]/'scripts/bungee-host.py')
        host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
        output=io.StringIO()
        with patch.object(host,'default_basemap',return_value=self.root/'world.mbtiles'),patch.object(host,'ask',side_effect=['1','1 2','1','done']),contextlib.redirect_stdout(output):
            result=host.choose_maps()
        self.assertEqual(result,['test-two']);self.assertIn('[x]',output.getvalue());self.assertIn('Combined selection:',output.getvalue())
    def test_new_snapshot_space_is_reserved_before_maps_even_for_sparse_private_data(self):
        directory=self.root/'volumes/server-data';directory.mkdir(parents=True)
        with (directory/'database').open('wb') as stream:stream.truncate(6*maps.GIB)
        self.capacity.stop()
        try:
            with patch.object(maps,'free_bytes',return_value=(8*maps.GIB,16*maps.GIB)):
                disk=maps.capacity(self.root)
            self.assertGreater(disk['snapshot_reserve_bytes'],6*maps.GIB)
            self.assertEqual(disk['available_bytes'],0)
        finally:self.capacity.start()
    def test_installer_requires_an_explicit_overview_only_choice(self):
        spec=importlib.util.spec_from_file_location('map_wizard_host',Path(__file__).resolve().parents[1]/'scripts/bungee-host.py')
        host=importlib.util.module_from_spec(spec);spec.loader.exec_module(host)
        with patch.object(host,'default_basemap',return_value=self.root/'world.mbtiles'),patch.object(host,'ask',side_effect=['done','yes']),contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(host.choose_maps(),[])
