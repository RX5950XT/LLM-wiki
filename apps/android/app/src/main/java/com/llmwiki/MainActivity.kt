package com.llmwiki

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.llmwiki.ui.theme.LlmWikiTheme
import com.llmwiki.ui.LlmWikiNavGraph

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            LlmWikiTheme {
                LlmWikiNavGraph()
            }
        }
    }
}
