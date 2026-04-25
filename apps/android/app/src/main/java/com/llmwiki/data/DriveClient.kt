package com.llmwiki.data

import android.content.Context
import com.google.api.client.googleapis.extensions.android.gms.auth.GoogleAccountCredential
import com.google.api.client.http.javanet.NetHttpTransport
import com.google.api.client.json.gson.GsonFactory
import com.google.api.services.drive.Drive
import com.google.api.services.drive.DriveScopes

class DriveClient(context: Context, accountName: String) {

    private val credential: GoogleAccountCredential = GoogleAccountCredential
        .usingOAuth2(context, listOf(DriveScopes.DRIVE_FILE))
        .apply { selectedAccountName = accountName }

    val service: Drive = Drive.Builder(
        NetHttpTransport(),
        GsonFactory.getDefaultInstance(),
        credential,
    )
        .setApplicationName("LLM Wiki")
        .build()

    suspend fun readFile(fileId: String): String {
        // TODO: implement Drive file read
        throw NotImplementedError("Phase 3")
    }

    suspend fun writeFile(fileId: String, content: String) {
        // TODO: implement Drive file write
        throw NotImplementedError("Phase 3")
    }
}
