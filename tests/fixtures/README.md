`GeoIP2-City-Test.mmdb` is the artificial test database from MaxMind/MaxMind-DB,
commit `0ee49278e35fd7bdf341ac236edbba20de1aceb9`, under its included MIT license.
It is not a production GeoIP dataset. Tests use 81.2.69.142 as an artificial
London observation (10 km database radius); no connection is made to that IP.

`geodata.py` creates a neutral synthetic PNG grid MBTiles file. Screenshot grids
are explicitly labeled synthetic; they are not OpenStreetMap street data.
Neither fixture is installed in production images or sent to a provider.

`recovery-test.jpg` is a locally generated 320×240 checkerboard labelled
“SYNTHETIC CAMERA TEST / No real phone or person”. Photo API/browser fixtures
use it instead of a person's image. It is never bundled with the production app.

`recovery-detail-test.jpg` is a deterministic, synthetic 2048×1536 colour/noise detail pattern, encoded at JPEG quality 90. It contains no person, EXIF or real camera capture. The maintainer-only `make_recovery_detail.py` reproduces it with Pillow; tests read the checked-in JPEG and need no image library.

`vector_map.py --detail` builds a deterministic synthetic PMTiles/MVT archive with a z15 road named “Synthetic Main Street” near 33,-80. The managed-map browser test exercises the real local renderer and street-label lookup using it. Its internal directories/metadata use gzip, matching production Protomaps extraction. It contains no real travel/location data and is not evidence of a provider's coverage or a verified postal address.
