package com.llmwiki.data

import android.content.Context
import com.google.api.client.googleapis.extensions.android.gms.auth.GoogleAccountCredential
import com.google.api.client.http.ByteArrayContent
import com.google.api.client.http.javanet.NetHttpTransport
import com.google.api.client.json.gson.GsonFactory
import com.google.api.services.drive.Drive
import com.google.api.services.drive.DriveScopes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

class DriveClient(context: Context, accountName: String) {

    private val credential: GoogleAccountCredential = GoogleAccountCredential
        .usingOAuth2(context, listOf(DriveScopes.DRIVE_FILE))
        .apply { selectedAccountName = accountName }

    private val service: Drive = Drive.Builder(
        NetHttpTransport(),
        GsonFactory.getDefaultInstance(),
        credential,
    )
        .setApplicationName("LLM Wiki")
        .build()

    /** Read the text content of a Drive file by ID. */
    suspend fun readFile(fileId: String): String = withContext(Dispatchers.IO) {
        val output = ByteArrayOutputStream()
        service.files().get(fileId)
            .executeMediaAndDownloadTo(output)
        output.toString(Charsets.UTF_8)
    }

    /**
     * Write (create or update) a markdown file in Drive.
     * If [fileId] is provided, the existing file is updated in place.
     * Returns the file ID.
     */
    suspend fun writeFile(
        content: String,
        name: String,
        parentId: String,
        fileId: String? = null,
    ): String = withContext(Dispatchers.IO) {
        val media = ByteArrayContent("text/markdown", content.toByteArray(Charsets.UTF_8))
        if (fileId != null) {
            val file = com.google.api.services.drive.model.File()
            val result = service.files().update(fileId, file, media)
                .setFields("id")
                .execute()
            result.id!!
        } else {
            val metadata = com.google.api.services.drive.model.File().apply {
                this.name = name
                mimeType = "text/markdown"
                parents = listOf(parentId)
            }
            val result = service.files().create(metadata, media)
                .setFields("id")
                .execute()
            result.id!!
        }
    }
}
