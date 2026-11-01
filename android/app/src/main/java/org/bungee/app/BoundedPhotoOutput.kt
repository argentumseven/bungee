package org.bungee.app

import java.io.ByteArrayOutputStream
import java.io.OutputStream

/** Let the codec finish, but never retain an oversized failed encoding in memory. */
class BoundedPhotoOutput(private val limit: Int): OutputStream() {
    init { require(limit > 0) }
    private val buffer=ByteArrayOutputStream(minOf(limit,64*1024))
    private var overflow=false
    val retainedBytes: Int get()=buffer.size()
    override fun write(value: Int) {
        if(buffer.size()<limit)buffer.write(value) else overflow=true
    }
    override fun write(bytes: ByteArray,offset: Int,length: Int) {
        if(offset<0 || length<0 || offset>bytes.size-length)throw IndexOutOfBoundsException()
        val keep=minOf(length,limit-buffer.size())
        if(keep>0)buffer.write(bytes,offset,keep)
        if(keep<length)overflow=true
    }
    fun reset() { buffer.reset();overflow=false }
    fun complete(): ByteArray? = if(overflow)null else buffer.toByteArray()
}
