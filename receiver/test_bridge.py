import hashlib
import json
import os
import tempfile
import unittest
from bridge import decode_message, Spool

VIN = "5YJ3E1EA7KF000001"


class BridgeTests(unittest.TestCase):
    def test_signal_types_and_receiver_timestamp(self):
        for payload, expected in [(b"0", 0), (b"false", False), (b"null", None), (b'"72.5"', "72.5")]:
            event = decode_message(f"tesla/{VIN}/v/Soc", payload, "tesla", {VIN}, 1789214400000)
            self.assertEqual(event["value"], expected)
            self.assertEqual(event["timestampSource"], "receiver")
            self.assertEqual(event["timestamp"], 1789214400000)

    def test_connectivity_preserves_vehicle_time(self):
        event = decode_message(f"tesla/{VIN}/connectivity", b'{"Status":"CONNECTED","CreatedAt":"2026-09-12T12:00:00Z"}', "tesla", {VIN}, 1789214405000)
        self.assertEqual(event["timestampSource"], "vehicle")
        self.assertEqual(event["timestamp"], 1789214400000)

    def test_unapproved_vin_rejected(self):
        with self.assertRaises(ValueError):
            decode_message(f"tesla/{VIN}/v/Soc", b"70", "tesla", set())

    def test_persistent_queue_survives_restart_and_deduplicates_mqtt_redelivery(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "spool.sqlite")
            event = decode_message(f"tesla/{VIN}/v/Soc", b"70", "tesla", {VIN})
            spool = Spool(path)
            spool.add(event, 7, False, "payload-hash")
            spool.db.close()
            restarted = Spool(path)
            restarted.add({**event, "id": "new-id"}, 7, True, "payload-hash")
            batch = restarted.batch()
            self.assertEqual(len(batch), 1)
            self.assertEqual(batch[0][0], event["id"])
            restarted.remove([event["id"]])
            restarted.add({**event, "id": "another-id"}, 7, True, "payload-hash")
            self.assertEqual(restarted.batch(), [])
            # Reuse of an MQTT packet ID for a new message is allowed.
            restarted.add({**event, "id": "actual-new-message"}, 7, False, "payload-hash")
            self.assertEqual(len(restarted.batch()), 1)
            restarted.db.close()


if __name__ == "__main__":
    unittest.main()
