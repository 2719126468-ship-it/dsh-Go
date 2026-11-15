import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../common/list_page_row.dart';
import '../shell/page_frame.dart';
import '../theme/app_icons.dart';
import 'web_view_page.dart';

/// Small browser hub for the ScreenClickCapture destinations and DSH-017 media.
///
/// Pages use the app's existing WebView; DSH-017 itself stays on the user's
/// host so neither its Python runtime nor its media dependencies inflate APKs.
class AiBrowserPage extends StatefulWidget {
  const AiBrowserPage({super.key, this.mediaOnly = false});

  final bool mediaOnly;

  @override
  State<AiBrowserPage> createState() => _AiBrowserPageState();
}

class _AiBrowserPageState extends State<AiBrowserPage> {
  static const _mediaUrlKey = 'dsh017_media_url';
  static const _mediaTokenKey = 'dsh017_media_token';
  static const _secureStorage = FlutterSecureStorage();

  final _address = TextEditingController();
  String _mediaUrl = '';
  bool _loaded = false;

  bool get _english => Localizations.localeOf(context).languageCode == 'en';

  String _text(String zh, String en) => _english ? en : zh;

  @override
  void initState() {
    super.initState();
    _loadMediaConfig();
  }

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _loadMediaConfig() async {
    final prefs = await SharedPreferences.getInstance();
    final url = prefs.getString(_mediaUrlKey) ?? '';
    if (!mounted) return;
    setState(() {
      _mediaUrl = url;
      _loaded = true;
    });
  }

  Future<bool> _editMediaConfig() async {
    final url = TextEditingController(text: _mediaUrl);
    final token = TextEditingController(text: await _secureStorage.read(key: _mediaTokenKey) ?? '');
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(_text('连接 DSH-017 媒体服务', 'Connect DSH-017 media')),
        content: SizedBox(
          width: double.maxFinite,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: url,
                keyboardType: TextInputType.url,
                autocorrect: false,
                decoration: InputDecoration(
                  labelText: _text('服务地址', 'Server URL'),
                  hintText: 'https://dsh017.example.com:8092',
                ),
              ),
              const SizedBox(height: 12),
              TextField(
                controller: token,
                obscureText: true,
                autocorrect: false,
                decoration: InputDecoration(
                  labelText: _text('访问 Token（普通 Token）', 'Access token (regular token)'),
                ),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: AlignmentDirectional.centerStart,
                child: Text(
                  _text(
                    '远程地址建议使用 HTTPS；HTTP 仅允许本机回环地址。Token 使用 Android 安全存储。',
                    'Use HTTPS for remote hosts. Cleartext HTTP is limited to loopback. The token is stored in Android secure storage.',
                  ),
                  style: Theme.of(dialogContext).textTheme.bodySmall,
                ),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext, false),
            child: Text(_text('取消', 'Cancel')),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(dialogContext, true),
            child: Text(_text('保存', 'Save')),
          ),
        ],
      ),
    );
    if (saved != true) {
      url.dispose();
      token.dispose();
      return false;
    }

    var value = url.text.trim();
    if (value.isNotEmpty && !value.contains('://')) value = 'https://$value';
    final parsed = Uri.tryParse(value);
    if (parsed == null || parsed.host.isEmpty || !const ['http', 'https'].contains(parsed.scheme)) {
      url.dispose();
      token.dispose();
      if (mounted) {
        ScaffoldMessenger.maybeOf(context)?.showSnackBar(
          SnackBar(content: Text(_text('请输入有效的 HTTP/HTTPS 地址', 'Enter a valid HTTP/HTTPS URL'))),
        );
      }
      return false;
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_mediaUrlKey, parsed.toString());
    if (token.text.isEmpty) {
      await _secureStorage.delete(key: _mediaTokenKey);
    } else {
      await _secureStorage.write(key: _mediaTokenKey, value: token.text);
    }
    url.dispose();
    token.dispose();
    if (!mounted) return false;
    setState(() {
      _mediaUrl = parsed.toString();
      _loaded = true;
    });
    return true;
  }

  Future<void> _openAddress() async {
    final value = _address.text.trim();
    if (value.isEmpty) return;
    final parsed = Uri.tryParse(value.contains('://') ? value : 'https://$value');
    final target = parsed != null && parsed.host.isNotEmpty
        ? parsed
        : Uri.https('www.google.com', '/search', {'q': value});
    _openPage(target, target.host);
  }

  Future<void> _openMedia() async {
    if (!_loaded) return;
    if (_mediaUrl.isEmpty && !await _editMediaConfig()) return;
    final token = await _secureStorage.read(key: _mediaTokenKey);
    if (!mounted || _mediaUrl.isEmpty) return;
    _openPage(
      Uri.parse(_mediaUrl),
      _text('DSH-017 · B站媒体', 'DSH-017 · Bilibili'),
      httpAuthUsername: token == null || token.isEmpty ? null : 'dsh017',
      httpAuthPassword: token,
    );
  }

  void _openPage(
    Uri url,
    String title, {
    String? httpAuthUsername,
    String? httpAuthPassword,
  }) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => WebViewPage(
          url: url,
          title: title,
          allowOpenExternal: true,
          httpAuthUsername: httpAuthUsername,
          httpAuthPassword: httpAuthPassword,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final mediaTitle = _text('B站媒体', 'Bilibili media');
    return AppPage.list(
      title: widget.mediaOnly ? mediaTitle : _text('AI 浏览器', 'AI Browser'),
      subtitle: Text(
        widget.mediaOnly
            ? _text('连接 DSH-017，继续使用搜索、播放器和媒体功能', 'Connect DSH-017 for its search, player and media tools')
            : _text('ChatGPT、Claude 与 DSH-017 媒体入口', 'ChatGPT, Claude and DSH-017 media'),
      ),
      actions: [
        GlassIconButton(
          icon: AppIcons.configure,
          tooltip: _text('配置 DSH-017', 'Configure DSH-017'),
          onPressed: _editMediaConfig,
        ),
      ],
      children: [
        if (!widget.mediaOnly) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: TextField(
              controller: _address,
              keyboardType: TextInputType.url,
              textInputAction: TextInputAction.go,
              autocorrect: false,
              onSubmitted: (_) => _openAddress(),
              decoration: InputDecoration(
                hintText: _text('输入网址或搜索关键词', 'Enter a URL or search term'),
                prefixIcon: const Icon(Icons.language),
                suffixIcon: IconButton(
                  tooltip: _text('打开', 'Open'),
                  onPressed: _openAddress,
                  icon: const Icon(Icons.arrow_forward),
                ),
              ),
            ),
          ),
          ListPageCard(
            title: _text('AI 服务', 'AI services'),
            children: [
              ListPageRow(
                icon: AppIcons.browser,
                title: 'ChatGPT',
                subtitle: 'chatgpt.com',
                onTap: () => _openPage(Uri.parse('https://chatgpt.com'), 'ChatGPT'),
              ),
              ListPageRow(
                icon: AppIcons.browser,
                title: 'Claude',
                subtitle: 'claude.ai',
                onTap: () => _openPage(Uri.parse('https://claude.ai'), 'Claude'),
              ),
            ],
          ),
          const SizedBox(height: 16),
        ],
        ListPageCard(
          title: mediaTitle,
          children: [
            ListPageRow(
              icon: AppIcons.mediaPlay,
              title: _text('打开 DSH-017 B站媒体', 'Open DSH-017 Bilibili media'),
              subtitle: _mediaUrl.isEmpty
                  ? _text('先配置正在运行的 DSH-017 服务地址', 'Configure a running DSH-017 server first')
                  : _mediaUrl,
              onTap: _openMedia,
            ),
            ListPageRow(
              icon: AppIcons.configure,
              title: _text('服务地址与访问凭据', 'Server URL and access token'),
              subtitle: _text('Token 只保存在本机安全存储', 'Token stays in secure device storage'),
              onTap: _editMediaConfig,
            ),
          ],
        ),
        const SizedBox(height: 16),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          child: Text(
            _text(
              '屏幕读取与点按复用 DSH Go「手机操控」现有能力，不再安装 ScreenClickCapture 中未接入的重复截屏服务。B站搜索列表恢复、分页和横屏全屏由 DSH-017 服务端提供。',
              'Screen reading and taps reuse DSH Go Phone Control. The unintegrated duplicate capture service from ScreenClickCapture is not bundled. Bilibili search restoration, pagination and landscape fullscreen are provided by the DSH-017 server.',
            ),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ),
      ],
    );
  }
}
