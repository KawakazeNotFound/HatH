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

import java.util.*;
import java.nio.charset.Charset;
import java.util.regex.Pattern;
import java.net.URL;
import java.io.File;

public class HTTPResponse {
	private static final Pattern absoluteUriPattern = Pattern.compile("^http://[^/]+/", Pattern.CASE_INSENSITIVE);

	private HTTPSession session;

	private boolean requestHeadOnly;
	private boolean servercmd;
	private int responseStatusCode;

	private HTTPResponseProcessor hpc;
	private boolean fileRequest;
	private boolean cacheHit;
	private String requestedFileId;
	private int requestedFileSize;

	public HTTPResponse(HTTPSession session) {
		this.session = session;
		servercmd = false;
		requestHeadOnly = false;
		responseStatusCode = 500;	// if nothing alters this, there's a bug somewhere
		fileRequest = false;
		cacheHit = false;
		requestedFileId = null;
		requestedFileSize = 0;
	}

	private HTTPResponseProcessor processRemoteAPICommand(String command, String additional) {
		Hashtable<String,String> addTable = Tools.parseAdditional(additional);
		HentaiAtHomeClient client = session.getHTTPServer().getHentaiAtHomeClient();

		try {
			if(command.equalsIgnoreCase("still_alive")) {
				return new HTTPResponseProcessorText("I feel FANTASTIC and I'm still alive");
			}
			else if(command.equalsIgnoreCase("threaded_proxy_test")) {
				return processThreadedProxyTest(addTable);
			}
			else if(command.equalsIgnoreCase("speed_test")) {
				String testsize = addTable.get("testsize");
				return new HTTPResponseProcessorSpeedtest(testsize != null ? Integer.parseInt(testsize) : 1000000);
			}
			else if(command.equalsIgnoreCase("refresh_settings")) {
				client.getServerHandler().refreshServerSettings();
				return new HTTPResponseProcessorText("");
			}
			else if(command.equalsIgnoreCase("start_downloader")) {
				client.startDownloader();
				return new HTTPResponseProcessorText("");
			}
			else if(command.equalsIgnoreCase("refresh_certs")) {
				client.setCertRefresh();
				return new HTTPResponseProcessorText("");
			}
		}
		catch(Exception e) {
			e.printStackTrace();
			Out.warning(session + " Failed to process command");
		}

		return new HTTPResponseProcessorText("INVALID_COMMAND");
	}

	private HTTPResponseProcessorText processThreadedProxyTest(Hashtable<String,String> addTable) {
		String hostname = addTable.get("hostname");
		String protocol = addTable.get("protocol");
		int port = Integer.parseInt(addTable.get("port"));
		int testsize = Integer.parseInt(addTable.get("testsize"));
		int testcount = Integer.parseInt(addTable.get("testcount"));
		int testtime = Integer.parseInt(addTable.get("testtime"));
		String testkey = addTable.get("testkey");

		Out.debug("Running speedtest against hostname=" + hostname + " protocol=" + protocol + " port=" + port + " testsize=" + testsize + " testcount=" + testcount + " testtime=" + testtime + " testkey=" + testkey);

		int successfulTests = 0;
		long totalTimeMillis = 0;

		try {
			List<FileDownloader> testfiles = Collections.checkedList(new ArrayList<FileDownloader>(), FileDownloader.class);

			for(int i=0; i<testcount; i++) {
				URL source = new URL(protocol == null ? "http" : protocol, hostname, port, "/t/" + testsize + "/" + testtime + "/" + testkey + "/" + (int) Math.floor(Math.random() * Integer.MAX_VALUE));
				//Out.debug("Test thread: " + source);
				FileDownloader dler = new FileDownloader(source, 10000, 60000, true);
				testfiles.add(dler);
				dler.startAsyncDownload();
			}

			for(FileDownloader dler : testfiles) {
				if(dler.waitAsyncDownload()) {
					if(dler.getContentLength() >= testsize) {
						successfulTests += 1;
						totalTimeMillis += dler.getDownloadTimeMillis();
					}
				}
			}
		}
		catch(java.net.MalformedURLException e) {
			HentaiAtHomeClient.dieWithError(e);
		}

		Out.debug("Ran speedtest against hostname=" + hostname + " testsize=" + testsize + " testcount=" + testcount + ", reporting successfulTests=" + successfulTests + " totalTimeMillis=" + totalTimeMillis);

		return new HTTPResponseProcessorText("OK:" + successfulTests + "-" + totalTimeMillis);
	}

	public void parseRequest(String request, boolean localNetworkAccess) {
		if(request == null) {
			Out.debug(session + " Client did not send a request.");
			responseStatusCode = 400;
			return;
		}

		String[] requestParts = request.trim().split(" ", 3);

		if(requestParts.length != 3) {
			Out.debug(session + " Invalid HTTP request form.");
			responseStatusCode = 400;
			return;
		}

		if( !(requestParts[0].equalsIgnoreCase("GET") || requestParts[0].equalsIgnoreCase("HEAD")) || !requestParts[2].startsWith("HTTP/") ) {
			Out.debug(session + " HTTP request is not GET or HEAD.");
			responseStatusCode = 405;
			return;
		}

		// The request URI may be an absolute path or an absolute URI for GET/HEAD requests (see section 5.1.2 of RFC2616)
		requestParts[1] = absoluteUriPattern.matcher(requestParts[1]).replaceFirst("/");
		String[] urlparts = requestParts[1].replace("%3d", "=").split("/");

		if( (urlparts.length < 2) || !urlparts[0].equals("")) {
			Out.debug(session + " The requested URL is invalid or not supported.");
			responseStatusCode = 404;
			return;
		}

		requestHeadOnly = requestParts[0].equalsIgnoreCase("HEAD");

		if(urlparts[1].equals("h")) {
			// form: /h/$fileid/$additional/$filename

			if(urlparts.length < 4) {
				responseStatusCode = 400;
				return;
			}

			String fileid = urlparts[2];
			requestedFileId = fileid;
			HVFile requestedHVFile = HVFile.getHVFileFromFileid(fileid);
			if(requestedHVFile != null) {
				fileRequest = true;
				requestedFileSize = requestedHVFile.getSize();
			}
			Hashtable<String,String> additional = Tools.parseAdditional(urlparts[3]);
			boolean keystampRejected = true;

			try {
				String[] keystampParts = additional.get("keystamp").split("-");

				if(keystampParts.length == 2) {
					int keystampTime = Integer.parseInt(keystampParts[0]);

					if(Math.abs(Settings.getServerTime() - keystampTime) < 900) {
						if( keystampParts[1].equalsIgnoreCase(Tools.getSHA1String(keystampTime + "-" + fileid + "-" + Settings.getClientKey() + "-hotlinkthis").substring(0, 10)) ) {
							keystampRejected = false;
						}
					}
				}
			} catch(Exception e) {}

			String fileindex = additional.get("fileindex");
			String xres = additional.get("xres");

			if(keystampRejected) {
				responseStatusCode = 403;
			}
			else if(requestedHVFile == null || fileindex == null || xres == null || !Pattern.matches("^\\d+$", fileindex) || !Pattern.matches("^org|\\d+$", xres)) {
				Out.debug(session + " Invalid or missing arguments.");
				responseStatusCode = 404;
			}
			else {
				File requestedFile = requestedHVFile.getLocalFileRef();

				if(requestedFile.exists() && (requestedFile.length() == requestedHVFile.getSize())) {
					cacheHit = true;
					// if this file has not been read for some time, and file verification is not on cooldown, verify the hash inline as the file is being sent, which is reasonably cheap
					CacheHandler cacheHandler = session.getHTTPServer().getHentaiAtHomeClient().getCacheHandler();
					boolean verifyFileIntegrity = false;

					if(cacheHandler.markRecentlyAccessed(requestedHVFile)) {
						verifyFileIntegrity = !Settings.isdisableFileVerification() && !cacheHandler.isFileVerificationOnCooldown();
					}

					// hpc will update responseStatusCode
					hpc = new HTTPResponseProcessorFile(session, requestedHVFile, verifyFileIntegrity);
				}
				else {
					cacheHit = false;
					// non-existent file, or existing file has the wrong size. do an on-demand request of the file directly from the image servers
					URL[] sources = session.getHTTPServer().getHentaiAtHomeClient().getServerHandler().getStaticRangeFetchURL(fileindex, xres, fileid);

					if(sources == null) {
						Out.debug(session + " Sources was empty for fileindex=" + fileindex + " xres=" + xres + " fileid=" + fileid);
						responseStatusCode = 404;
					}
					else {
						// hpc will update responseStatusCode
						hpc = new HTTPResponseProcessorProxy(session, fileid, sources);
					}
				}
			}

			return;
		}
		else if(urlparts[1].equals("local")) {
			// local cache browser:
			// /local/cache
			// /local/cache/token=$token
			// /local/cache/list/prefix=$prefix;limit=$limit;offset=$offset;token=$token
			// /local/cache/file/$fileid/token=$token

			if(urlparts.length < 3 || !urlparts[2].equals("cache")) {
				responseStatusCode = 404;
				return;
			}

			if(urlparts.length == 3 || (urlparts.length == 4 && !urlparts[3].equals("list") && !urlparts[3].equals("file"))) {
				String additional = urlparts.length == 4 ? urlparts[3] : "";
				if(!isCacheBrowserAccessAllowed(localNetworkAccess, additional)) {
					responseStatusCode = 403;
					return;
				}

				hpc = new HTTPResponseProcessorText(getCacheListJson(additional), "application/json", Charset.forName("UTF-8"));
				responseStatusCode = 200;
				return;
			}

			if(urlparts.length >= 4 && urlparts[3].equals("list")) {
				String additional = urlparts.length >= 5 ? urlparts[4] : "";
				if(!isCacheBrowserAccessAllowed(localNetworkAccess, additional)) {
					responseStatusCode = 403;
					return;
				}

				hpc = new HTTPResponseProcessorText(getCacheListJson(additional), "application/json", Charset.forName("UTF-8"));
				responseStatusCode = 200;
				return;
			}

			if(urlparts.length >= 5 && urlparts[3].equals("file")) {
				String fileid = urlparts[4];
				String additional = urlparts.length >= 6 ? urlparts[5] : "";
				if(!isCacheBrowserAccessAllowed(localNetworkAccess, additional)) {
					responseStatusCode = 403;
					return;
				}

				HVFile requestedHVFile = HVFile.getHVFileFromFileid(fileid);
				if(requestedHVFile == null) {
					responseStatusCode = 404;
					return;
				}

				File requestedFile = requestedHVFile.getLocalFileRef();
				if(!requestedFile.exists() || requestedFile.length() != requestedHVFile.getSize()) {
					responseStatusCode = 404;
					return;
				}

				hpc = new HTTPResponseProcessorFile(session, requestedHVFile, false, false);
				responseStatusCode = 200;
				return;
			}

			responseStatusCode = 404;
			return;
		}
		else if(urlparts[1].equals("servercmd")) {
			// form: /servercmd/$command/$additional/$time/$key

			if(!Settings.isValidRPCServer(session.getSocketInetAddress())) {
				Out.debug(session + " Got a servercmd from an unauthorized IP address");
				responseStatusCode = 403;
				return;
			}

			if(urlparts.length < 6) {
				Out.debug(session + " Got a malformed servercmd");
				responseStatusCode = 403;
				return;
			}

			String command = urlparts[2];
			String additional = urlparts[3];
			int commandTime = Integer.parseInt(urlparts[4]);
			String key = urlparts[5];

			if( (Math.abs(commandTime - Settings.getServerTime()) > Settings.MAX_KEY_TIME_DRIFT) || !Tools.getSHA1String("hentai@home-servercmd-" + command + "-" + additional + "-" + Settings.getClientID() + "-" + commandTime + "-" + Settings.getClientKey()).equals(key) ) {
				Out.debug(session + " Got a servercmd with expired or incorrect key");
				responseStatusCode = 403;
				return;
			}

			responseStatusCode = 200;
			servercmd = true;
			hpc = processRemoteAPICommand(command, additional);
			return;
		}
		else if(urlparts[1].equals("t")) {
			// form: /t/$testsize/$testtime/$testkey

			if(urlparts.length < 5) {
				responseStatusCode = 400;
				return;
			}

			// send a randomly generated file of a given length for speed testing purposes
			int testsize = Integer.parseInt(urlparts[2]);
			int testtime = Integer.parseInt(urlparts[3]);
			String testkey = urlparts[4];

			if(Math.abs(testtime - Settings.getServerTime()) > Settings.MAX_KEY_TIME_DRIFT) {
				Out.debug(session + " Got a speedtest request with expired key");
				responseStatusCode = 403;
				return;
			}

			if(!Tools.getSHA1String("hentai@home-speedtest-" + testsize + "-" + testtime + "-" + Settings.getClientID() + "-" + Settings.getClientKey()).equals(testkey)) {
				Out.debug(session + " Got a speedtest request with invalid key");
				responseStatusCode = 403;
				return;
			}

			Out.debug("Sending threaded proxy test with testsize=" + testsize + " testtime=" + testtime + " testkey=" + testkey);

			responseStatusCode = 200;
			hpc = new HTTPResponseProcessorSpeedtest(testsize);
			return;
		}
		else if(urlparts.length == 2) {
			if(urlparts[1].equals("favicon.ico")) {
				// Redirect to the main website icon (which should already be in the browser cache).
				hpc = new HTTPResponseProcessorText("");
				hpc.addHeaderField("Location", "https://e-hentai.org/favicon.ico");
				responseStatusCode = 301; // Moved Permanently
				return;
			}
			else if(urlparts[1].equals("robots.txt")) {
				// Bots are not welcome.
				hpc = new HTTPResponseProcessorText("User-agent: *\nDisallow: /", "text/plain");
				responseStatusCode = 200; // Found
				return;
			}
		}

		Out.debug(session + " Invalid request type '" + urlparts[1]);
		responseStatusCode = 404;
		return;
	}

	public HTTPResponseProcessor getHTTPResponseProcessor() {
		if(hpc == null) {
			hpc = new HTTPResponseProcessorText("An error has occurred. (" + responseStatusCode + ")");

			if(responseStatusCode == 405) {
				hpc.addHeaderField("Allow", "GET,HEAD");
			}
		}
		else if(hpc instanceof HTTPResponseProcessorFile) {
			responseStatusCode = hpc.initialize();
		}
		else if(hpc instanceof HTTPResponseProcessorProxy) {
			responseStatusCode = hpc.initialize();
		}
		else if(hpc instanceof HTTPResponseProcessorSpeedtest) {
			Stats.setProgramStatus("Running speed tests...");
		}

		return hpc;
	}

	public void requestCompleted() {
		hpc.requestCompleted();
	}

	// accessors

	public int getResponseStatusCode() {
		return responseStatusCode;
	}

	public boolean isRequestHeadOnly() {
		return requestHeadOnly;
	}

	public boolean isServercmd() {
		return servercmd;
	}

	private boolean isCacheBrowserAccessAllowed(boolean localNetworkAccess, String additional) {
		if(localNetworkAccess) {
			return true;
		}

		String expected = Settings.getTelemetryToken();
		if(expected == null || expected.isEmpty()) {
			return false;
		}

		Hashtable<String,String> add = Tools.parseAdditional(additional);
		String token = add.get("token");
		return expected.equals(token);
	}

	private String getCacheListJson(String additional) {
		Hashtable<String,String> add = Tools.parseAdditional(additional);
		String prefix = add.get("prefix");
		int limit = parseIntSafe(add.get("limit"), 200, 1, 500);
		int offset = parseIntSafe(add.get("offset"), 0, 0, Integer.MAX_VALUE);
		if(prefix == null) {
			prefix = "";
		}
		prefix = prefix.toLowerCase();
		if(!Pattern.matches("^[a-f0-9]{0,40}$", prefix)) {
			prefix = "";
		}

		StringBuilder sb = new StringBuilder(1024);
		sb.append("{");
		sb.append("\"prefix\":\"").append(prefix).append("\",");
		sb.append("\"offset\":").append(offset).append(",");
		sb.append("\"limit\":").append(limit).append(",");
		sb.append("\"items\":[");

		File cacheDir = Settings.getCacheDir();
		int emitted = 0;
		int total = 0;
		Integer nextOffset = null;

		if(prefix.length() == 0) {
			File[] l1dirs = Tools.listSortedFiles(cacheDir);
			if(l1dirs != null) {
				for(File dir : l1dirs) {
					if(!dir.isDirectory()) {
						continue;
					}
					if(emitted > 0) {
						sb.append(",");
					}
					sb.append("{\"type\":\"dir\",\"name\":\"").append(dir.getName()).append("\",\"prefix\":\"").append(dir.getName()).append("\"}");
					++emitted;
				}
			}
			sb.append("]}");
			return sb.toString();
		}

		if(prefix.length() == 2) {
			File l1 = new File(cacheDir, prefix);
			File[] l2dirs = Tools.listSortedFiles(l1);
			if(l2dirs != null) {
				for(File dir : l2dirs) {
					if(!dir.isDirectory()) {
						continue;
					}
					if(emitted > 0) {
						sb.append(",");
					}
					sb.append("{\"type\":\"dir\",\"name\":\"").append(dir.getName()).append("\",\"prefix\":\"").append(prefix).append(dir.getName()).append("\"}");
					++emitted;
				}
			}
			sb.append("]}");
			return sb.toString();
		}

		if(prefix.length() >= 4) {
			String l1 = prefix.substring(0, 2);
			String l2 = prefix.substring(2, 4);
			File targetDir = new File(new File(cacheDir, l1), l2);
			File[] files = Tools.listSortedFiles(targetDir);
			if(files != null) {
				for(File f : files) {
					if(!f.isFile()) {
						continue;
					}
					String name = f.getName();
					if(!name.startsWith(prefix)) {
						continue;
					}
					++total;
					if(total <= offset) {
						continue;
					}
					if(emitted >= limit) {
						nextOffset = offset + emitted;
						break;
					}

					HVFile hvFile = HVFile.getHVFileFromFileid(name);
					if(hvFile == null) {
						continue;
					}
					if(emitted > 0) {
						sb.append(",");
					}
					sb.append("{\"type\":\"file\",\"fileid\":\"").append(name).append("\",\"display_name\":\"").append(getDisplayName(hvFile));
					sb.append("\",\"extension\":\"").append(getDisplayExtension(hvFile.getType())).append("\",\"size\":").append(hvFile.getSize());
					sb.append(",\"mime\":\"").append(hvFile.getMimeType()).append("\",\"last_modified\":").append(f.lastModified() / 1000).append("}");
					++emitted;
				}
			}
		}

		sb.append("],\"next_offset\":");
		if(nextOffset == null) {
			sb.append("null");
		}
		else {
			sb.append(nextOffset.intValue());
		}
		sb.append("}");
		return sb.toString();
	}

	private int parseIntSafe(String value, int def, int min, int max) {
		try {
			int v = Integer.parseInt(value);
			return Math.max(min, Math.min(max, v));
		}
		catch(Exception e) {
			return def;
		}
	}

	private String getDisplayName(HVFile hvFile) {
		return hvFile.getHash() + "." + getDisplayExtension(hvFile.getType());
	}

	private String getDisplayExtension(String type) {
		if(type.equals("wbp")) {
			return "webp";
		}

		if(type.equals("wbm")) {
			return "webm";
		}

		if(type.equals("avf")) {
			return "avif";
		}

		return type;
	}

	public boolean isFileRequest() {
		return fileRequest;
	}

	public boolean isCacheHit() {
		return cacheHit;
	}

	public String getRequestedFileId() {
		return requestedFileId;
	}

	public int getRequestedFileSize() {
		return requestedFileSize;
	}
}
