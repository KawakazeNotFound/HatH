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

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

public class CacheBrowserServer implements Runnable {
	private static final String CRLF = "\r\n";
	private static final Charset UTF8 = Charset.forName("UTF-8");
	private static final Charset ISO88591 = Charset.forName("ISO-8859-1");

	private ServerSocket listener = null;
	private Thread thread = null;
	private boolean running = false;

	public boolean start() {
		try {
			String bindHost = Settings.getCacheBrowserHost();
			int port = Settings.getCacheBrowserPort();
			if(port < 1 || port > 65535) {
				Out.warning("CacheBrowserServer: Invalid port " + port);
				return false;
			}
			listener = new ServerSocket(port, 50, InetAddress.getByName(bindHost));
			running = true;
			thread = new Thread(this);
			thread.setName("CacheBrowserServer");
			thread.start();
			Out.info("CacheBrowserServer: Listening on http://" + bindHost + ":" + port + "/local/cache");
			return true;
		}
		catch(Exception e) {
			Out.warning("CacheBrowserServer: Failed to start: " + e.getMessage());
			return false;
		}
	}

	public void stop() {
		running = false;
		if(listener != null) {
			try {
				listener.close();
			}
			catch(Exception e) {}
			listener = null;
		}
	}

	public void run() {
		while(running) {
			try {
				Socket socket = listener.accept();
				Thread handler = new Thread(new CacheBrowserSession(socket));
				handler.setName("CacheBrowserSession");
				handler.start();
			}
			catch(Exception e) {
				if(running) {
					Out.warning("CacheBrowserServer: Listener error: " + e.getMessage());
				}
			}
		}
	}

	private static class CacheBrowserSession implements Runnable {
		private Socket socket;

		CacheBrowserSession(Socket socket) {
			this.socket = socket;
		}

		public void run() {
			BufferedReader reader = null;
			DataOutputStream writer = null;

			try {
				socket.setSoTimeout(10000);
				reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), ISO88591));
				writer = new DataOutputStream(socket.getOutputStream());

				String request = reader.readLine();
				if(request == null) {
					return;
				}

				String line;
				int readLines = 0;
				while((line = reader.readLine()) != null && line.length() > 0 && ++readLines < 100) {}

				handleRequest(request, writer);
			}
			catch(Exception e) {
				Out.debug("CacheBrowserServer: Connection failed: " + e.getMessage());
			}
			finally {
				try { if(reader != null) reader.close(); } catch(Exception e) {}
				try { if(writer != null) writer.close(); } catch(Exception e) {}
				try { socket.close(); } catch(Exception e) {}
			}
		}

		private void handleRequest(String request, DataOutputStream writer) throws java.io.IOException {
			String[] parts = request.trim().split(" ", 3);
			if(parts.length != 3 || !(parts[0].equalsIgnoreCase("GET") || parts[0].equalsIgnoreCase("HEAD")) || !parts[2].startsWith("HTTP/")) {
				writeText(writer, 405, "text/plain; charset=utf-8", "Method Not Allowed", false);
				return;
			}

			boolean headOnly = parts[0].equalsIgnoreCase("HEAD");
			RequestTarget target = parseTarget(parts[1]);
			if(target == null || !target.path.startsWith("/local/cache")) {
				writeText(writer, 404, "text/plain; charset=utf-8", "Not Found", headOnly);
				return;
			}

			String[] pathParts = target.path.split("/");
			String action = pathParts.length > 3 ? pathParts[3] : "";
			String additional = target.additional;
			if(action.equals("file") && pathParts.length > 4 && isAdditional(pathParts[pathParts.length - 1])) {
				additional = joinAdditional(additional, pathParts[pathParts.length - 1]);
			}

			if(!CacheBrowser.isAccessAllowed(false, additional)) {
				writeText(writer, 403, "text/plain; charset=utf-8", "Permission Denied", headOnly);
				return;
			}

			if(action.length() == 0 || isAdditional(action) || action.equals("list")) {
				if(action.length() == 0 || isAdditional(action)) {
					writeText(writer, 200, "text/html; charset=utf-8", getBrowserHtml(additional), headOnly);
					return;
				}

				String json = CacheBrowser.getCacheListJson(additional);
				writeText(writer, 200, "application/json; charset=utf-8", json, headOnly);
				return;
			}

			if(action.equals("file") && pathParts.length >= 5) {
				String fileid = urlDecode(pathParts[4]);
				HVFile hvFile = CacheBrowser.resolveCachedFile(fileid);
				if(hvFile == null) {
					writeText(writer, 404, "text/plain; charset=utf-8", "Not Found", headOnly);
					return;
				}

				writeFile(writer, hvFile, headOnly);
				return;
			}

			writeText(writer, 404, "text/plain; charset=utf-8", "Not Found", headOnly);
		}

		private RequestTarget parseTarget(String rawTarget) {
			try {
				String target = rawTarget.replace("%3d", "=").replace("%3D", "=");
				int queryIndex = target.indexOf("?");
				String path = queryIndex >= 0 ? target.substring(0, queryIndex) : target;
				String query = queryIndex >= 0 ? target.substring(queryIndex + 1) : "";
				String additional = queryToAdditional(query);
				String[] pathParts = path.split("/");

				if(pathParts.length >= 5 && pathParts[3].equals("list")) {
					additional = joinAdditional(additional, pathParts[4]);
				}
				else if(pathParts.length == 4 && isAdditional(pathParts[3])) {
					additional = joinAdditional(additional, pathParts[3]);
				}

				RequestTarget requestTarget = new RequestTarget();
				requestTarget.path = path;
				requestTarget.additional = additional;
				return requestTarget;
			}
			catch(Exception e) {
				return null;
			}
		}

		private static String queryToAdditional(String query) {
			if(query == null || query.length() == 0) {
				return "";
			}

			StringBuilder sb = new StringBuilder(query.length());
			for(String part : query.split("&")) {
				if(part.length() == 0) {
					continue;
				}
				if(sb.length() > 0) {
					sb.append(";");
				}
				sb.append(part);
			}
			return sb.toString();
		}

		private static boolean isAdditional(String value) {
			return value != null && value.indexOf("=") >= 0;
		}

		private static String joinAdditional(String a, String b) {
			if(b == null || b.length() == 0) {
				return a == null ? "" : a;
			}
			if(a == null || a.length() == 0) {
				return b;
			}
			return a + ";" + b;
		}

		private static String urlDecode(String value) {
			try {
				return URLDecoder.decode(value, "UTF-8");
			}
			catch(Exception e) {
				return value;
			}
		}

		private String getBrowserHtml(String additional) {
			String token = Tools.parseAdditional(additional).get("token");
			if(token == null) {
				token = "";
			}

			return "<!doctype html>\n" +
"<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>H@H Cache Browser</title>\n" +
"<style>\n" +
":root{color-scheme:dark;--bg:#202322;--fg:#eef2ee;--muted:#9aa7a1;--line:#353b38;--panel:#2b302d;--link:#d8e8bd;--accent:#72b7a8}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:Arial,Helvetica,sans-serif;font-size:15px}.wrap{max-width:1480px;margin:28px auto;padding:0 24px}h1{font-size:34px;font-weight:300;margin:0 0 16px;color:#9bd48f}.layout{display:grid;grid-template-columns:minmax(420px,1fr) minmax(360px,42%);gap:20px;align-items:start}.bar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin-bottom:16px}input,button{background:#171a19;color:var(--fg);border:1px solid #59635e;border-radius:4px;padding:6px 9px}button{cursor:pointer;color:var(--link)}.path{color:var(--muted);margin-left:auto}.list{min-width:0}.entry{display:grid;grid-template-columns:32px minmax(0,1fr) auto auto auto;gap:10px;align-items:center;min-height:42px;border-bottom:1px solid var(--line)}.entry:hover{background:rgba(255,255,255,.04)}a{color:var(--link);text-decoration:none}.name{overflow-wrap:anywhere}.sub{display:block;color:var(--muted);font-size:12px;margin-top:2px}.pill{border-radius:4px;padding:3px 7px;background:#477d76;color:#fff;font-size:12px}.bytes{background:#668d57}.icon{font-size:12px;color:var(--accent);text-align:center}.preview{position:sticky;top:20px;min-height:360px;background:#171a19;border:1px solid var(--line);border-radius:6px;padding:14px;overflow:hidden}.preview img,.preview video{display:block;width:100%;max-height:calc(100vh - 160px);object-fit:contain;background:#000;border-radius:4px}.caption{color:var(--muted);margin-bottom:10px;overflow-wrap:anywhere}.empty{height:320px;display:grid;place-items:center;color:var(--muted);border:1px dashed #46504b;border-radius:4px}.nav-buttons{display:flex;gap:10px;margin-top:14px;align-items:center}.nav-buttons button{flex:1}@media(max-width:900px){.wrap{padding:0 14px}.layout{display:block}.preview{position:static;margin-top:18px}.entry{grid-template-columns:28px minmax(0,1fr)}.entry .pill,.entry .age{display:none}.path{width:100%;margin-left:0}}\n" +
"</style></head><body><main class=\"wrap\"><h1>File Browser</h1><section class=\"bar\"><label>prefix: <input id=\"prefix\" type=\"text\" placeholder=\"e03c\"></label><button onclick=\"goPrefix()\">open</button><button onclick=\"openPrefix('')\">root</button><span class=\"path\">/cache/<code id=\"path\"></code></span></section><div class=\"layout\"><section id=\"list\" class=\"list\"></section><aside id=\"preview\" class=\"preview\"><div class=\"empty\">Select a file to preview.</div></aside></div></main>\n" +
"<script>\n" +
"const token=" + jsString(token) + ";let currentPrefix='',currentItems=[],nextOffset=null,offset=0;const limit=500;let sortedFiles=[],currentIndex=-1;\n" +
"function esc(s){return String(s||'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}\n" +
"function size(n){n=Number(n||0);const u=['bytes','KB','MB','GB'];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++;}return (i===0?Math.round(n):n.toFixed(2))+' '+u[i];}\n" +
"function age(ts){if(!ts)return '';let s=Math.max(1,Math.floor(Date.now()/1000-ts));for(const p of [['year',31536000],['month',2592000],['day',86400],['hour',3600],['minute',60]]){if(s>=p[1]){const x=Math.floor(s/p[1]);return x+' '+p[0]+(x>1?'s':'')+' ago';}}return 'seconds ago';}\n" +
"function qs(){return 'token='+encodeURIComponent(token);}\n" +
"function parentPrefix(){if(currentPrefix.length>=4)return currentPrefix.substring(0,2);if(currentPrefix.length>=2)return '';return null;}\n" +
"function goPrefix(){openPrefix(document.getElementById('prefix').value.trim().toLowerCase());}\n" +
"async function openPrefix(prefix,append){if(!append){offset=0;currentItems=[];}currentPrefix=prefix||'';document.getElementById('prefix').value=currentPrefix;document.getElementById('path').textContent=currentPrefix?currentPrefix.match(/.{1,2}/g).join('/')+'/':'';const res=await fetch('/local/cache/list?'+qs()+'&prefix='+encodeURIComponent(currentPrefix)+'&limit='+limit+'&offset='+offset);const data=await res.json();if(data.error){document.getElementById('list').innerHTML='<div class=entry><span></span><span class=name>'+esc(data.error)+'</span><span></span><span></span><span></span></div>';return;}currentItems=currentItems.concat(data.items||[]);nextOffset=data.next_offset;renderList();}\n" +
"function renderList(){const list=document.getElementById('list');const oldFileId=currentIndex>=0?sortedFiles[currentIndex]?.fileid:null;sortedFiles=currentItems.filter(i=>i.type==='file');if(oldFileId)currentIndex=sortedFiles.findIndex(f=>f.fileid===oldFileId);let html='';const parent=parentPrefix();if(parent!==null){html+='<div class=entry><span class=icon>..</span><a class=name href=# onclick=\"openPrefix(\\''+parent+'\\');return false;\">..</a><span></span><span></span><span></span></div>';}let folderCount=0;let fileCount=0;for(const item of currentItems){if(item.type==='dir'){folderCount++;html+='<div class=entry><span class=icon>[D]</span><a class=name href=# onclick=\"openPrefix(\\''+esc(item.prefix)+'\\');return false;\">'+esc(item.name)+'</a><span class=pill>folder</span><span></span><span></span></div>';}else{fileCount++;html+='<div class=entry><span class=icon>[F]</span><a class=name href=# onclick=\"preview(\\''+esc(item.fileid)+'\\',\\''+esc(item.mime)+'\\');return false;\">'+esc(item.display_name||item.fileid)+'<span class=sub>'+esc(item.fileid)+'</span></a><span class=pill>'+esc(item.extension||item.mime)+'</span><span class=\"pill bytes\">'+size(item.size)+'</span><span class=\"sub age\">'+age(item.last_modified)+'</span></div>';}}if(folderCount||fileCount){html+='<div style=\"margin-top:16px;color:var(--muted);font-size:12px;padding:0 8px;\">'+(folderCount?folderCount+' folder(s)':'')+(folderCount&&fileCount?', ':'')+(fileCount?fileCount+' file(s)':'')+'</div>';}if(nextOffset!=null){html+='<div style=\"margin-top:16px\"><button onclick=\"offset=nextOffset;openPrefix(currentPrefix,true)\">load more</button></div>';}list.innerHTML=html;}\n" +
"function preview(fileid,mime,index){if(index===undefined)index=sortedFiles.findIndex(f=>f.fileid===fileid);currentIndex=index;const url='/local/cache/file/'+encodeURIComponent(fileid)+'?'+qs();const box=document.getElementById('preview');const cap='<div class=caption>'+esc(fileid)+' <a href=\"'+url+'\" target=\"_blank\" rel=\"noopener\">open direct</a></div>';const nav='<div class=\"nav-buttons\"><button onclick=\"navigate(-1)\" '+(currentIndex<=0?'disabled':'')+'>Previous</button><button onclick=\"navigate(1)\" '+(currentIndex>=sortedFiles.length-1?'disabled':'')+'>Next</button></div>';box.innerHTML=mime.startsWith('video/')?cap+'<video controls src=\"'+url+'\"></video>'+nav:cap+'<img src=\"'+url+'\" />'+nav;}\n" +
"function navigate(dir){const newIndex=currentIndex+dir;if(newIndex>=0&&newIndex<sortedFiles.length){const item=sortedFiles[newIndex];preview(item.fileid,item.mime,newIndex);}}\n" +
"window.addEventListener('keydown',e=>{if(document.activeElement.tagName==='INPUT')return;if(e.key==='ArrowLeft')navigate(-1);if(e.key==='ArrowRight')navigate(1);});\n" +
"openPrefix('');\n" +
"</script></body></html>";
		}

		private String jsString(String value) {
			if(value == null) {
				return "\"\"";
			}

			StringBuilder sb = new StringBuilder(value.length() + 8);
			sb.append("\"");
			for(int i = 0; i < value.length(); i++) {
				char c = value.charAt(i);
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
			sb.append("\"");
			return sb.toString();
		}

		private void writeText(DataOutputStream writer, int status, String contentType, String body, boolean headOnly) throws java.io.IOException {
			byte[] content = body.getBytes(UTF8);
			writeHeader(writer, status, contentType, content.length);
			if(!headOnly) {
				writer.write(content);
			}
			writer.flush();
		}

		private void writeFile(DataOutputStream writer, HVFile hvFile, boolean headOnly) throws java.io.IOException {
			File file = hvFile.getLocalFileRef();
			writeHeader(writer, 200, hvFile.getMimeType(), hvFile.getSize());
			if(headOnly) {
				writer.flush();
				return;
			}

			BufferedInputStream in = new BufferedInputStream(new FileInputStream(file));
			try {
				byte[] buffer = new byte[65536];
				int read;
				while((read = in.read(buffer)) >= 0) {
					writer.write(buffer, 0, read);
				}
			}
			finally {
				try { in.close(); } catch(Exception e) {}
			}
			writer.flush();
		}

		private void writeHeader(DataOutputStream writer, int status, String contentType, int contentLength) throws java.io.IOException {
			SimpleDateFormat sdf = new SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss", Locale.US);
			sdf.setTimeZone(TimeZone.getTimeZone("UTC"));
			StringBuilder header = new StringBuilder(256);
			header.append(statusHeader(status));
			header.append("Date: ").append(sdf.format(new Date())).append(" GMT").append(CRLF);
			header.append("Server: H@H Cache Browser ").append(Settings.CLIENT_VERSION).append(CRLF);
			header.append("Connection: close").append(CRLF);
			header.append("Content-Type: ").append(contentType).append(CRLF);
			header.append("Cache-Control: private, max-age=60").append(CRLF);
			header.append("Content-Length: ").append(contentLength).append(CRLF);
			header.append("Access-Control-Allow-Origin: *").append(CRLF);
			header.append(CRLF);
			writer.write(header.toString().getBytes(ISO88591));
		}

		private String statusHeader(int status) {
			switch(status) {
				case 200: return "HTTP/1.1 200 OK" + CRLF;
				case 403: return "HTTP/1.1 403 Permission Denied" + CRLF;
				case 404: return "HTTP/1.1 404 Not Found" + CRLF;
				case 405: return "HTTP/1.1 405 Method Not Allowed" + CRLF;
				default: return "HTTP/1.1 500 Internal Server Error" + CRLF;
			}
		}
	}

	private static class RequestTarget {
		String path;
		String additional;
	}
}
