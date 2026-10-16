`GeoIP2-City-Test.mmdb` is the artificial test database from MaxMind/MaxMind-DB,
commit `0ee49278e35fd7bdf341ac236edbba20de1aceb9`, under its included MIT license.
It is not a production GeoIP dataset. Tests use 81.2.69.142 as an artificial
London observation (10 km database radius); no connection is made to that IP.

`geodata.py` creates a neutral synthetic PNG grid MBTiles file. Screenshot grids
are explicitly labeled synthetic; they are not OpenStreetMap street data.
Neither fixture is installed in production images or sent to a provider.
