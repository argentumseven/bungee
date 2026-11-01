package org.bungee.app

import org.junit.Assert.*
import org.junit.Test

class BoundedPhotoOutputTest {
    @Test fun oversizeEncodingRetainsOnlyTheBudgetAndIsNeverReturnedAsATruncatedPhoto() {
        val output=BoundedPhotoOutput(1024)
        output.write(ByteArray(4096))
        assertEquals(1024,output.retainedBytes);assertNull(output.complete())
        output.reset();output.write(byteArrayOf(1,2,3));assertArrayEquals(byteArrayOf(1,2,3),output.complete())
    }
    @Test fun exactLimitSucceedsAndByteWiseOverflowIsAlsoRefused() {
        val output=BoundedPhotoOutput(4)
        repeat(4){output.write(it)};assertEquals(4,output.complete()!!.size)
        output.write(5);assertEquals(4,output.retainedBytes);assertNull(output.complete())
    }
}
