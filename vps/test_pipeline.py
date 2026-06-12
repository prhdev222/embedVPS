import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from pipeline import chunk_pages, file_sha256, normalize_text, point_id


class PipelineTests(unittest.TestCase):
    def test_normalize_text_removes_nulls_and_excess_spacing(self) -> None:
        self.assertEqual(normalize_text("A\x00   B\n\n\nC"), "A B\n\nC")

    def test_chunk_pages_preserves_page_numbers_and_overlap(self) -> None:
        chunks = chunk_pages(["A" * 300, "B" * 450], chunk_size=200, overlap=20)
        self.assertEqual([chunk.page for chunk in chunks], [1, 1, 2, 2, 2])
        self.assertEqual(chunks[0].text[-20:], chunks[1].text[:20])

    def test_file_and_point_ids_are_deterministic(self) -> None:
        digest = file_sha256(b"same pdf")
        self.assertEqual(digest, file_sha256(b"same pdf"))
        self.assertEqual(point_id(digest, 2, 3), point_id(digest, 2, 3))
        self.assertNotEqual(point_id(digest, 2, 3), point_id(digest, 2, 4))


if __name__ == "__main__":
    unittest.main()
