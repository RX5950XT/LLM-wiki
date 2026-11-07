package com.llmwiki.sync

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.llmwiki.BuildConfig
import com.llmwiki.R
import com.llmwiki.data.AndroidHttpClient
import com.llmwiki.data.SupabaseClientProvider
import com.llmwiki.data.requireAccessToken
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import java.io.File
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/**
 * Hands an import to the server, surviving a killed app and a dead network: the payload is
 * already on disk and WorkManager re-runs this after a process death or once online again.
 * The server takes the same `client_request_id` as the same job, so a re-send cannot import twice.
 * From then on the job runs server-side and needs no client at all.
 */
class IngestUploadWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val requestId = inputData.getString(KEY_REQUEST_ID) ?: return Result.failure()
        val kind = inputData.getString(KEY_KIND) ?: return Result.failure()
        val payloadFile = File(outboxDir(applicationContext), requestId)
        if (runAttemptCount >= MAX_ATTEMPTS) return giveUp(payloadFile, 0, null)
        if (kind != "url" && !payloadFile.exists()) return giveUp(payloadFile, 0, null)

        return try {
            val token = SupabaseClientProvider.client.requireAccessToken(forceRefresh = false)
                ?: return giveUp(payloadFile, 401, null)
            var response = post(kind, requestId, payloadFile, token)
            if (response.status.value == 401) {
                val refreshed = SupabaseClientProvider.client.requireAccessToken(forceRefresh = true)
                    ?: return giveUp(payloadFile, 401, null)
                response = post(kind, requestId, payloadFile, refreshed)
            }
            val status = response.status.value
            val body = response.bodyAsText()
            when {
                // Vercel can answer 200 with an HTML page for a route not deployed yet.
                status in 200..299 && hasJobId(body) -> {
                    payloadFile.delete()
                    Result.success(workDataOf(KEY_JOB_ID to jobId(body)))
                }
                status in 200..299 || status == 408 || status == 425 || status == 429 || status >= 500 -> Result.retry()
                else -> giveUp(payloadFile, status, errorMessage(body))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Network trouble: WorkManager waits for a connection and tries again with backoff.
            Result.retry()
        }
    }

    private fun giveUp(payloadFile: File, status: Int, message: String?): Result {
        payloadFile.delete()
        return Result.failure(
            workDataOf(
                KEY_ERROR_STATUS to status,
                KEY_ERROR_MESSAGE to message,
                KEY_TITLE to inputData.getString(KEY_TITLE),
            ),
        )
    }

    private suspend fun post(kind: String, requestId: String, payloadFile: File, token: String): HttpResponse {
        val url = BuildConfig.WEB_API_BASE_URL.trimEnd('/') + "/api/ingest"
        val autoRoute = inputData.getBoolean(KEY_AUTO_ROUTE, false)
        val workspaceId = inputData.getString(KEY_WORKSPACE_ID).orEmpty()
        val profileId = inputData.getString(KEY_PROFILE_ID)
        val locale = inputData.getString(KEY_LOCALE) ?: "zh-TW"
        return AndroidHttpClient.instance.post(url) {
            header("Authorization", "Bearer $token")
            header("x-llm-wiki-locale", locale)
            if (kind == "file") {
                val name = inputData.getString(KEY_TITLE).orEmpty()
                val mime = inputData.getString(KEY_MIME) ?: "application/octet-stream"
                val bytes = payloadFile.readBytes()
                setBody(
                    MultiPartFormDataContent(
                        formData {
                            append("client_request_id", requestId)
                            if (autoRoute) {
                                append("auto_route", "true")
                                append("fallback_workspace_id", workspaceId)
                            } else {
                                append("workspace_id", workspaceId)
                            }
                            profileId?.let { append("profile_id", it) }
                            append(
                                "file",
                                bytes,
                                Headers.build {
                                    // Ktor already adds `form-data; name="file"`. Repeating it makes a second
                                    // header, the server reads the first, and the file arrives without a filename.
                                    append(HttpHeaders.ContentDisposition, "filename=\"$name\"")
                                    append(HttpHeaders.ContentType, mime)
                                },
                            )
                        },
                    ),
                )
            } else {
                contentType(ContentType.Application.Json)
                setBody(
                    buildJsonObject {
                        put("kind", kind)
                        put("client_request_id", requestId)
                        if (kind == "url") {
                            put("url", inputData.getString(KEY_URL).orEmpty())
                        } else {
                            put("title", inputData.getString(KEY_TITLE).orEmpty())
                            put("content", payloadFile.readText())
                        }
                        if (autoRoute) {
                            put("auto_route", true)
                            put("fallback_workspace_id", workspaceId)
                        } else {
                            put("workspace_id", workspaceId)
                        }
                        profileId?.let { put("profile_id", it) }
                    }.toString(),
                )
            }
        }
    }

    /** Only used below Android 12, where expedited work runs as a foreground service. */
    override suspend fun getForegroundInfo(): ForegroundInfo {
        val manager = applicationContext.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                applicationContext.getString(R.string.ingest_uploading),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        val notification = NotificationCompat.Builder(applicationContext, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(applicationContext.getString(R.string.ingest_uploading))
            .setOngoing(true)
            .build()
        return ForegroundInfo(NOTIFICATION_ID, notification)
    }

    private fun parse(body: String): JsonObject? =
        runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull()

    private fun jobId(body: String): String? =
        (parse(body)?.get("jobId") as? JsonPrimitive)?.contentOrNull

    private fun hasJobId(body: String): Boolean = !jobId(body).isNullOrBlank()

    private fun errorMessage(body: String): String? {
        val root = parse(body) ?: return null
        return when (val error = root["error"]) {
            is JsonPrimitive -> error.contentOrNull
            is JsonObject -> (error["message"] as? JsonPrimitive)?.contentOrNull
            else -> null
        }
    }

    companion object {
        const val TAG = "LlmWikiIngestUpload"
        const val KEY_REQUEST_ID = "requestId"
        const val KEY_KIND = "kind"
        const val KEY_URL = "url"
        const val KEY_TITLE = "title"
        const val KEY_MIME = "mime"
        const val KEY_AUTO_ROUTE = "autoRoute"
        const val KEY_WORKSPACE_ID = "workspaceId"
        const val KEY_PROFILE_ID = "profileId"
        const val KEY_LOCALE = "locale"
        const val KEY_JOB_ID = "jobId"
        const val KEY_ERROR_STATUS = "errorStatus"
        const val KEY_ERROR_MESSAGE = "errorMessage"

        private const val CHANNEL_ID = "ingest_upload"
        private const val NOTIFICATION_ID = 4201
        /** With backoff this spans hours of unlucky retries; being offline does not use any up. */
        private const val MAX_ATTEMPTS = 12

        fun outboxDir(context: Context): File = File(context.filesDir, "ingest_outbox").apply { mkdirs() }

        fun enqueue(
            context: Context,
            requestId: String,
            kind: String,
            url: String? = null,
            title: String? = null,
            mime: String? = null,
            autoRoute: Boolean,
            workspaceId: String,
            profileId: String?,
            locale: String,
        ) {
            val request = OneTimeWorkRequestBuilder<IngestUploadWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .addTag(TAG)
                .setInputData(
                    workDataOf(
                        KEY_REQUEST_ID to requestId,
                        KEY_KIND to kind,
                        KEY_URL to url,
                        KEY_TITLE to title,
                        KEY_MIME to mime,
                        KEY_AUTO_ROUTE to autoRoute,
                        KEY_WORKSPACE_ID to workspaceId,
                        KEY_PROFILE_ID to profileId,
                        KEY_LOCALE to locale,
                    ),
                )
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("ingest-upload-$requestId", ExistingWorkPolicy.KEEP, request)
        }

        /** On sign-out: nothing queued may be sent under the next account. */
        fun cancelAll(context: Context) {
            WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
            outboxDir(context).listFiles()?.forEach { it.delete() }
        }
    }
}
