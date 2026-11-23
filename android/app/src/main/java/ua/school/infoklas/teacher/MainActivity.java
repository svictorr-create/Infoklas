package ua.school.infoklas.teacher;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import java.io.OutputStream;
import java.net.URLDecoder;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * ІнфоКлас — додаток вчителя.
 * Відкриває кабінет вчителя з сервера школи (ті самі функції, що й у браузері) і додає те, чого браузер не вміє:
 * сповіщення Android з вібрацією, вибір файлів з телефона, завантаження файлів учнів, кнопку «Назад».
 */
public class MainActivity extends Activity {
    private static final String PREFS = "infoklas";
    private static final String CHANNEL = "infoklas_events";
    private static final int REQ_FILE = 10, REQ_NOTIF = 11;
    private static final String SETUP = "file:///android_asset/setup.html";

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> fileCallback;
    private boolean visible = false;
    private int notifId = 100;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        // Android 15+: вміст під системними панелями — відсуваємо його
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                int types = WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime();
                android.graphics.Insets i = insets.getInsets(types);
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            }
            return insets; // Android 8–10: система сама залишає місце під панелями
        });

        setupWebView();
        createChannel();
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIF);
        }

        String server = prefs.getString("server", null);
        String link = getIntent() != null ? getIntent().getStringExtra("link") : null;
        if (state != null) web.restoreState(state);
        else if (server == null) web.loadUrl(SETUP);
        else web.loadUrl(server + "/" + (link != null ? link : "#/"));
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " InfoKlasTeacherApp/" + BuildConfigVersion());
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.addJavascriptInterface(new Bridge(), "InfoKlasApp");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String server = prefs.getString("server", "");
                if (u.toString().startsWith("file:///android_asset/")) return false;
                if (!server.isEmpty() && u.toString().startsWith(server)) return false;
                // зовнішні посилання (YouTube, тести) — у браузері телефона
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) {
                    String server = prefs.getString("server", "");
                    view.loadUrl("file:///android_asset/offline.html?server=" + Uri.encode(server) + "&err=" + Uri.encode(String.valueOf(err.getDescription())));
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = params.createIntent();
                i.addCategory(Intent.CATEGORY_OPENABLE);
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try { startActivityForResult(Intent.createChooser(i, "Оберіть файл"), REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }
        });

        // Файли учнів, ZIP-архіви, CSV — у «Завантаження» телефона
        web.setDownloadListener((url, ua, disposition, mime, length) -> {
            if (url.startsWith("blob:") || url.startsWith("data:")) return;
            try {
                String name = fileName(url, disposition, mime);
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                r.addRequestHeader("User-Agent", ua);
                r.setTitle(name);
                r.setMimeType(mime);
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "InfoKlas/" + name);
                ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
                Toast.makeText(this, "Завантажується: " + name, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, "Не вдалося завантажити: " + e.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private static String BuildConfigVersion() { return "1.0"; }

    private static String fileName(String url, String disposition, String mime) {
        if (disposition != null) {
            Matcher m = Pattern.compile("filename\\*=UTF-8''([^;]+)", Pattern.CASE_INSENSITIVE).matcher(disposition);
            if (m.find()) { try { return URLDecoder.decode(m.group(1), "UTF-8").replaceAll("[/\\\\]", "_"); } catch (Exception ignored) { } }
        }
        return URLUtil.guessFileName(url, disposition, mime);
    }

    // ---------- Міст для веб-застосунку: window.InfoKlasApp ----------
    private class Bridge {
        @JavascriptInterface public String server() { return prefs.getString("server", ""); }
        @JavascriptInterface public String version() { return BuildConfigVersion(); }

        @JavascriptInterface public void saveServer(String url) {
            String u = url == null ? "" : url.trim();
            if (u.isEmpty()) return;
            if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
            while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
            final String fu = u;
            prefs.edit().putString("server", fu).apply();
            runOnUiThread(() -> { web.clearHistory(); web.loadUrl(fu + "/#/"); });
        }

        @JavascriptInterface public void changeServer() {
            runOnUiThread(() -> web.loadUrl(SETUP + "?current=" + Uri.encode(prefs.getString("server", ""))));
        }

        @JavascriptInterface public void reload() {
            runOnUiThread(() -> { String s = prefs.getString("server", null); if (s != null) web.loadUrl(s + "/#/"); else web.loadUrl(SETUP); });
        }

        /** Подія від сервера (запитання учня, здана робота…): на екрані — вібрація, у фоні — сповіщення Android */
        @JavascriptInterface public void notify(String text, String link) {
            runOnUiThread(() -> {
                vibrate();
                if (!visible) showNotification(text, link);
            });
        }

        /** Збереження файлу, створеного на сторінці (наприклад, журнал у CSV) */
        @JavascriptInterface public void saveFile(String name, String mime, String base64) {
            if (Build.VERSION.SDK_INT < 29) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Збереження файлів потребує Android 10 або новішого", Toast.LENGTH_LONG).show());
                return;
            }
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/InfoKlas");
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                try (OutputStream os = getContentResolver().openOutputStream(uri)) { os.write(data); }
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Збережено: Завантаження/InfoKlas/" + name, Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Не вдалося зберегти: " + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }
    }

    private void vibrate() {
        Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (v != null && v.hasVibrator()) v.vibrate(VibrationEffect.createOneShot(180, VibrationEffect.DEFAULT_AMPLITUDE));
    }

    private void createChannel() {
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Події уроку", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Запитання учнів, здані роботи, події кіосків");
        ch.enableVibration(true);
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).createNotificationChannel(ch);
    }

    private void showNotification(String text, String link) {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (link != null && link.startsWith("#")) i.putExtra("link", link);
        PendingIntent pi = PendingIntent.getActivity(this, notifId, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("ІнфоКлас")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        ((NotificationManager) getSystemService(NOTIFICATION_SERVICE)).notify(notifId++, n);
    }

    // ---------- Життєвий цикл ----------
    @Override protected void onResume() { super.onResume(); visible = true; }
    @Override protected void onPause() { super.onPause(); visible = false; CookieManager.getInstance().flush(); }
    @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String link = intent.getStringExtra("link");
        String server = prefs.getString("server", null);
        if (link != null && server != null) web.loadUrl(server + "/" + link);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(multi(res, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(req, res, data);
    }

    private Uri[] multi(int res, Intent data) {
        if (res != RESULT_OK || data == null) return null;
        if (data.getClipData() != null) {
            Uri[] out = new Uri[data.getClipData().getItemCount()];
            for (int k = 0; k < out.length; k++) out[k] = data.getClipData().getItemAt(k).getUri();
            return out;
        }
        return data.getData() != null ? new Uri[]{data.getData()} : null;
    }

    /** «Назад»: спершу закрити вікно на сторінці, потім — попередня сторінка, потім — згорнути додаток */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(function(){var m=document.querySelectorAll('.modal-bg');if(m.length){m[m.length-1].remove();return 'closed';}return '';})()", r -> {
            if (r != null && r.contains("closed")) return;
            if (web.canGoBack()) web.goBack(); else moveTaskToBack(true);
        });
    }
}
