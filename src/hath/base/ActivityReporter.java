/*

Copyright 2008-2026 E-Hentai.org
https://forums.e-hentai.org/
tenboro@e-hentai.org

This file is part of Hentai@Home.

Hentai@Home is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

Hentai@Home is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with Hentai@Home.  If not, see <https://www.gnu.org/licenses/>.

*/

package hath.base;

import java.io.File;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;

public class ActivityReporter implements Runnable {
	private static final Charset UTF8 = Charset.forName("UTF-8");
	private static final Object instanceLock = new Object();
	private static ActivityReporter instance = null;

	private final String endpoint;
	private final String authToken;
	private final int batchSize;
	private final int maxQueue;
	private final int flushIntervalSec;
	private final int heartbeatIntervalSec;

	private final List<ActivityEvent> queue = new ArrayList<ActivityEvent>();
	private long droppedEvents = 0;
	private long lastFlush = 0;
	private long lastHeartbeat = 0;
	private boolean running = false;
	private Thread thread;

	private ActivityReporter(String endpoint, String authToken, int batchSize, int maxQueue, int flushIntervalSec, int heartbeatIntervalSec) {
		this.endpoint = endpoint;
		this.authToken = authToken;
		this.batchSize = batchSize;
		this.maxQueue = maxQueue;
		this.flushIntervalSec = flushIntervalSec;
		this.heartbeatIntervalSec = heartbeatIntervalSec;
	}

	public static void startIfEnabled() {
		if(!Settings.isTelemetryEnabled()) {
			return;
		}

		String endpoint = Settings.getTelemetryEndpoint();
		if(endpoint == null || endpoint.trim().isEmpty()) {
			Out.warning("ActivityReporter: telemetry enabled but endpoint is empty");
			return;
		}

		synchronized(instanceLock) {
			if(instance != null) {
				return;
			}

			instance = new ActivityReporter(
					endpoint.trim(),
					Settings.getTelemetryToken(),
					Settings.getTelemetryBatchSize(),
					Settings.getTelemetryMaxQueue(),
					Settings.getTelemetryFlushInterval(),
					Settings.getTelemetryHeartbeatInterval()
			);
			Out.info("ActivityReporter: Enabled endpoint=" + endpoint.trim() + " heartbeat=" + Settings.getTelemetryHeartbeatInterval() + "s flush=" + Settings.getTelemetryFlushInterval() + "s batch=" + Settings.getTelemetryBatchSize() + " queue=" + Settings.getTelemetryMaxQueue() + " name=" + Settings.getTelemetryName() + " timeout=" + Settings.getTelemetryTimeout() + "s");
			instance.writeCacheProxyScript();
			instance.start();
		}
	}

	public static void shutdown() {
		ActivityReporter reporter;
		synchronized(instanceLock) {
			reporter = instance;
			instance = null;
		}

		if(reporter != null) {
			reporter.stopAndFlush();
		}
	}

	public static void recordRequest(String remoteIp, String fileId, int fileSize, int statusCode, int bytes, boolean cacheHit, int durationMs) {
		ActivityReporter reporter;
		synchronized(instanceLock) {
			reporter = instance;
		}

		if(reporter == null || fileId == null || fileId.isEmpty()) {
			return;
		}

		ActivityEvent ev = new ActivityEvent();
		ev.ts = System.currentTimeMillis() / 1000;
		ev.remoteIp = remoteIp;
		ev.fileId = fileId;
		ev.fileSize = fileSize;
		ev.statusCode = statusCode;
		ev.bytes = bytes;
		ev.cacheHit = cacheHit;
		ev.durationMs = durationMs;

		reporter.enqueue(ev);
	}

	private void start() {
		running = true;
		thread = new Thread(this);
		thread.setName("ActivityReporter");
		thread.setDaemon(true);
		thread.start();
	}

	private void stopAndFlush() {
		running = false;
		if(thread != null) {
			try {
				thread.join(2000);
			}
			catch(InterruptedException e) {}
		}
		flush(true, true);
	}

	private void enqueue(ActivityEvent ev) {
		synchronized(queue) {
			if(queue.size() >= maxQueue) {
				++droppedEvents;
				return;
			}

			queue.add(ev);
		}
	}

	public void run() {
		while(running) {
			long now = System.currentTimeMillis();
			boolean heartbeatDue = heartbeatIntervalSec > 0 && now - lastHeartbeat >= heartbeatIntervalSec * 1000L;
			boolean flushDue = flushIntervalSec > 0 && now - lastFlush >= flushIntervalSec * 1000L;
			boolean sizeDue = false;

			synchronized(queue) {
				sizeDue = queue.size() >= batchSize;
			}

			if(heartbeatDue || flushDue || sizeDue) {
				flush(false, heartbeatDue);
			}

			try {
				Thread.currentThread().sleep(1000);
			}
			catch(InterruptedException e) {}
		}
	}

	private void flush(boolean force, boolean includeHeartbeat) {
		List<ActivityEvent> snapshot = null;
		long droppedSnapshot = 0;

		synchronized(queue) {
			if(queue.isEmpty() && !includeHeartbeat && !force) {
				return;
			}

			snapshot = new ArrayList<ActivityEvent>(queue);
			droppedSnapshot = droppedEvents;
		}

		String payload = buildPayload(snapshot, includeHeartbeat, droppedSnapshot);
		if(payload == null) {
			return;
		}

		if(postJson(payload)) {
			if(includeHeartbeat || force) {
				Out.info("ActivityReporter: Posted telemetry events=" + snapshot.size() + " dropped=" + droppedSnapshot + " heartbeat=" + includeHeartbeat);
			}
			long now = System.currentTimeMillis();
			lastFlush = now;
			if(includeHeartbeat) {
				lastHeartbeat = now;
			}

			synchronized(queue) {
				int removeCount = Math.min(snapshot.size(), queue.size());
				if(removeCount > 0) {
					queue.subList(0, removeCount).clear();
				}
				droppedEvents = 0;
			}
		}
		else {
			Out.warning("ActivityReporter: Telemetry post failed events=" + snapshot.size() + " dropped=" + droppedSnapshot + " heartbeat=" + includeHeartbeat);
		}
	}

	private String buildPayload(List<ActivityEvent> events, boolean includeHeartbeat, long dropped) {
		StringBuilder sb = new StringBuilder(1024);
		long now = System.currentTimeMillis() / 1000;
		String name = Settings.getTelemetryName();
		int timeout = Settings.getTelemetryTimeout();
		if(name == null || name.trim().isEmpty()) {
			name = "client-" + Settings.getClientID();
		}

		sb.append("{");
		sb.append("\"client_id\":").append(Settings.getClientID()).append(",");
		sb.append("\"ts\":").append(now);
		sb.append(",\"name\":\"").append(jsonEscape(name)).append("\"");
		sb.append(",\"cache_url\":\"").append(jsonEscape(getCacheBrowserUrl())).append("\"");
		sb.append(",\"timeout\":").append(timeout);

		if(includeHeartbeat) {
			sb.append(",\"uptime_s\":").append(Stats.getUptime());
			sb.append(",\"files_sent\":").append(Stats.getFilesSent());
			sb.append(",\"bytes_sent\":").append(Stats.getBytesSent());
			sb.append(",\"cache_count\":").append(Stats.getCacheCount());
			sb.append(",\"cache_size\":").append(Stats.getCacheSize());
			sb.append(",\"open_connections\":").append(Stats.getOpenConnections());
		}

		sb.append(",\"dropped\":").append(dropped);
		sb.append(",\"events\":[");

		for(int i = 0; i < events.size(); i++) {
			ActivityEvent ev = events.get(i);
			if(i > 0) {
				sb.append(",");
			}

			sb.append("{");
			sb.append("\"ts\":").append(ev.ts).append(",");
			sb.append("\"ip\":\"").append(jsonEscape(ev.remoteIp)).append("\",");
			sb.append("\"fileid\":\"").append(jsonEscape(ev.fileId)).append("\",");
			sb.append("\"file_size\":").append(ev.fileSize).append(",");
			sb.append("\"status\":").append(ev.statusCode).append(",");
			sb.append("\"bytes\":").append(ev.bytes).append(",");
			sb.append("\"cache_hit\":").append(ev.cacheHit ? 1 : 0).append(",");
			sb.append("\"duration_ms\":").append(ev.durationMs);
			sb.append("}");
		}

		sb.append("]}");
		return sb.toString();
	}

	private String getCacheBrowserUrl() {
		String override = Settings.getCacheUrlOverride();
		if(override != null && override.trim().length() > 0) {
			return appendToken(override.trim());
		}

		String host = Settings.getClientHost();
		int port = Settings.getClientPort();
		if(host == null || host.length() < 1 || port < 1) {
			return "";
		}

		return appendToken("https://" + host.replace("::ffff:", "") + ":" + port + "/local/cache");
	}

	private String appendToken(String url) {
		String token = Settings.getTelemetryToken();
		if(token == null || token.length() < 1 || url.indexOf("token=") >= 0) {
			return url;
		}

		return url + (url.endsWith("/") ? "" : "/") + "token=" + token;
	}

	private void writeCacheProxyScript() {
		try {
			File script = new File(Settings.getDataDir(), "hath-cache-proxy.sh");
			String token = Settings.getTelemetryToken() == null ? "" : Settings.getTelemetryToken();
			String content =
"#!/bin/sh\n" +
"set -eu\n" +
"\n" +
"DOMAIN=\"${HATH_CACHE_DOMAIN:-}\"\n" +
"HATH_PORT=\"${HATH_CACHE_PORT:-" + Settings.getClientPort() + "}\"\n" +
"SCRIPT_DIR=\"$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\"\n" +
"CADDYFILE=\"$SCRIPT_DIR/Caddyfile.hath-cache\"\n" +
"\n" +
"if [ -z \"$DOMAIN\" ]; then\n" +
"  echo \"Set HATH_CACHE_DOMAIN first, for example:\"\n" +
"  echo \"  HATH_CACHE_DOMAIN=jp1-cache.example.com sh $0\"\n" +
"  echo \"Then start H@H with: --cache-url=https://jp1-cache.example.com/local/cache\"\n" +
"  exit 1\n" +
"fi\n" +
"\n" +
"if ! command -v caddy >/dev/null 2>&1; then\n" +
"  echo \"caddy is required. Install it first: https://caddyserver.com/docs/install\"\n" +
"  exit 1\n" +
"fi\n" +
"\n" +
"cat > \"$CADDYFILE\" <<EOF\n" +
"$DOMAIN {\n" +
"  reverse_proxy https://127.0.0.1:$HATH_PORT {\n" +
"    transport http {\n" +
"      tls_insecure_skip_verify\n" +
"    }\n" +
"  }\n" +
"}\n" +
"EOF\n" +
"\n" +
"echo \"Starting cache proxy for https://$DOMAIN -> https://127.0.0.1:$HATH_PORT\"\n" +
"echo \"Recommended H@H cache URL: https://$DOMAIN/local/cache" + (token.length() > 0 ? "/token=" + shellEscapeForEcho(token) : "") + "\"\n" +
"exec caddy run --config \"$CADDYFILE\" --adapter caddyfile\n";

			Tools.putStringFileContents(script, content, "UTF-8");
			script.setExecutable(true, false);
			Out.info("ActivityReporter: Wrote cache proxy helper script to " + script);
		}
		catch(Exception e) {
			Out.warning("ActivityReporter: Failed to write cache proxy helper script: " + e.getMessage());
		}
	}

	private String shellEscapeForEcho(String s) {
		return s.replace("\\", "\\\\").replace("\"", "\\\"");
	}

	private boolean postJson(String payload) {
		HttpURLConnection conn = null;

		try {
			URL url = new URL(endpoint);
			conn = (HttpURLConnection) url.openConnection();
			conn.setRequestMethod("POST");
			conn.setConnectTimeout(2000);
			conn.setReadTimeout(5000);
			conn.setDoOutput(true);
			conn.setRequestProperty("Content-Type", "application/json");
			conn.setRequestProperty("Accept", "application/json");
			conn.setRequestProperty("User-Agent", "HathTelemetry/1.0");

			if(authToken != null && authToken.length() > 0) {
				conn.setRequestProperty("X-Auth-Token", authToken);
			}

			byte[] body = payload.getBytes(UTF8);
			conn.setFixedLengthStreamingMode(body.length);

			OutputStream os = conn.getOutputStream();
			os.write(body);
			os.flush();
			os.close();

			int code = conn.getResponseCode();
			if(code < 200 || code >= 300) {
				Out.warning("ActivityReporter: Telemetry endpoint returned HTTP " + code);
			}
			return code >= 200 && code < 300;
		}
		catch(Exception e) {
			Out.debug("ActivityReporter: Failed to post telemetry: " + e.getMessage());
		}
		finally {
			if(conn != null) {
				try { conn.disconnect(); } catch(Exception e) {}
			}
		}

		return false;
	}

	private String jsonEscape(String s) {
		if(s == null) {
			return "";
		}

		StringBuilder sb = new StringBuilder(s.length() + 8);
		for(int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch(c) {
				case '\\': sb.append("\\\\"); break;
				case '"': sb.append("\\\""); break;
				case '\n': sb.append("\\n"); break;
				case '\r': sb.append("\\r"); break;
				case '\t': sb.append("\\t"); break;
				default:
					if(c < 32) {
						sb.append(" ");
					}
					else {
						sb.append(c);
					}
					break;
			}
		}

		return sb.toString();
	}

	private static class ActivityEvent {
		long ts;
		String remoteIp;
		String fileId;
		int fileSize;
		int statusCode;
		int bytes;
		boolean cacheHit;
		int durationMs;
	}
}
