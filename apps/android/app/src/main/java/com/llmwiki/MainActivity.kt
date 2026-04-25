package com.llmwiki

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.llmwiki.ui.LlmWikiNavGraph
import com.llmwiki.ui.theme.LlmWikiTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val shareUrl = extractSharedUrl(intent)

        setContent {
            LlmWikiTheme {
                LlmWikiNavGraph(shareUrl = shareUrl)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Re-launch with a fresh Compose tree to pick up the new share intent.
        // Since singleTop/singleTask is not set, the system creates a new instance;
        // but if the activity is already running and receives ACTION_SEND, recreate
        // with the new intent to surface the ingest dialog.
        val shareUrl = extractSharedUrl(intent)
        if (shareUrl != null) {
            setContent {
                LlmWikiTheme {
                    LlmWikiNavGraph(shareUrl = shareUrl)
                }
            }
        }
    }

    /** Extracts a URL from an incoming ACTION_SEND text/plain intent. */
    private fun extractSharedUrl(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND) return null
        if (intent.type != "text/plain") return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
        // Take the first token that looks like a URL; Chrome sends "Title\nURL" or just "URL"
        return text.lines()
            .map { it.trim() }
            .firstOrNull { it.startsWith("http://") || it.startsWith("https://") }
    }
}
