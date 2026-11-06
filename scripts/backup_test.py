"""Exercise the backup scripts with real age and isolated Docker/SSH fixtures."""
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent
MOCK = r'''#!/usr/bin/env python3
import fcntl, hashlib, os, pathlib, shutil, subprocess, sys
p = pathlib.Path
args = sys.argv[1:]
name = p(sys.argv[0]).name
with open(os.environ['TEST_LOG'], 'a') as log:
    log.write(name + ' ' + ' '.join(args) + '\n')
if name == 'flock':
    try: fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(1)
elif name == 'docker':
    if 'pg_dump' in args:
        sys.stdout.buffer.write(p(os.environ['TEST_DUMP']).read_bytes())
        sys.exit(1 if os.environ.get('TEST_FAIL') == 'dump' else 0)
    elif args[0] == 'run':
        sys.stdout.buffer.write(p(os.environ['TEST_REPLAY']).read_bytes())
        sys.exit(1 if os.environ.get('TEST_FAIL') == 'replay' else 0)
    elif 'ps' in args: print('test-worker')
elif name == 'age':
    data = sys.stdin.buffer.read()
    failure = os.environ.get('TEST_FAIL')
    if data and (failure == 'encrypt-dump' or (failure == 'encrypt-replay' and not data.startswith(b'PGDMP'))):
        sys.stdout.buffer.write(b'partial ciphertext')
        sys.exit(1)
    sys.exit(subprocess.run([os.environ['TEST_REAL_AGE'], *args], input=data).returncode)
elif name == 'mv':
    if os.environ.get('TEST_FAIL') == 'publish' and args[0].endswith('database.age'): sys.exit(1)
    shutil.move(*args)
elif name == 'ssh':
    remote = p(os.environ['TEST_REMOTE'])
    command = args[-1]
    if command.startswith('find '):
        names = sorted(f.name for f in remote.iterdir() if f.name.endswith(('.dump', '.dump.age')))
        if names: print(names[-1])
    elif command.startswith('test -f '): sys.exit(0 if (remote / command.split('/')[-1]).is_file() else 1)
    elif command.startswith('sha256sum '):
        target = remote / command.split('/')[-1]
        print(hashlib.sha256(target.read_bytes()).hexdigest() + '  ' + target.name)
    else: sys.exit('unexpected SSH command')
elif name == 'rsync':
    source = p(os.environ['TEST_REMOTE']) / args[-2].split('/')[-1]
    shutil.copyfile(source, args[-1])
    if os.environ.get('TEST_FAIL') == 'transfer':
        p(args[-1]).write_bytes(b'partial transfer')
        sys.exit(1)
    if os.environ.get('TEST_FAIL') == 'checksum': p(args[-1]).write_bytes(b'corrupt transfer')
'''


class BackupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.age = shutil.which('age')
        if not cls.age or not shutil.which('age-keygen'):
            raise RuntimeError('Install age and age-keygen to run backup tests')

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        for name in ('docker', 'flock', 'ssh', 'rsync'):
            self.mock(name)
        self.key = self.root / 'identity'
        subprocess.run(['age-keygen', '-o', str(self.key)], check=True, capture_output=True)
        self.recipients = self.root / 'recipients'
        self.recipients.write_bytes(subprocess.check_output(['age-keygen', '-y', str(self.key)]))
        self.dump = self.root / 'fixture.dump'
        self.dump.write_bytes(b'PGDMP synthetic private database contents')
        self.replay = self.root / 'fixture.tar.gz'
        with tarfile.open(self.replay, 'w:gz') as archive:
            data = b'private replay contents'
            entry = tarfile.TarInfo('object')
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
        self.backups = self.root / 'backups'
        self.log = self.root / 'commands'
        self.env = dict(os.environ, PATH=f'{self.bin}:{os.environ["PATH"]}',
                        CLICKSHIELD_APP_DIR=str(self.root),
                        CLICKSHIELD_BACKUP_DIR=str(self.backups),
                        CLICKSHIELD_BACKUP_RECIPIENTS_FILE=str(self.recipients),
                        CLICKSHIELD_REPLAY_VOLUME='test-replay',
                        CLICKSHIELD_BACKUP_HOST='test-host',
                        TEST_LOG=str(self.log), TEST_DUMP=str(self.dump),
                        TEST_REPLAY=str(self.replay), TEST_REAL_AGE=self.age)

    def mock(self, name):
        script = self.bin / name
        script.write_text(MOCK)
        script.chmod(0o755)

    def run_script(self, name, success=True):
        result = subprocess.run(['bash', str(SCRIPTS / name)], env=self.env,
                                capture_output=True, text=True, timeout=20)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)
        return result

    def decrypt(self, path, key=None):
        return subprocess.check_output([self.age, '-d', '-i', str(key or self.key), str(path)], stderr=subprocess.DEVNULL)

    def test_encrypted_pair_and_retention(self):
        self.backups.mkdir()
        old_names = ['clickshield-20000101T000000Z' + suffix for suffix in
                     ('.dump', '.replay.tar.gz', '.dump.age', '.replay.tar.gz.age')]
        for name in old_names:
            path = self.backups / name
            path.touch()
            os.utime(path, (0, 0))
        self.run_script('backup.sh')
        database, = self.backups.glob('*.dump.age')
        objects, = self.backups.glob('*.replay.tar.gz.age')
        self.assertEqual(self.decrypt(database), self.dump.read_bytes())
        self.assertEqual(self.decrypt(objects), self.replay.read_bytes())
        self.assertNotIn(b'private', database.read_bytes())
        for path in (database, objects):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.backups.stat().st_mode & 0o777, 0o700)
        self.assertFalse([p for p in self.backups.glob('.backup.*') if p.is_dir()])
        self.assertFalse(list(self.backups.glob('*.dump')))
        self.assertFalse(list(self.backups.glob('*.tar.gz')))
        for name in old_names:
            self.assertFalse((self.backups / name).exists())
        self.assertIn('up -d --no-deps worker', self.log.read_text())
        wrong_key = self.root / 'wrong-identity'
        subprocess.run(['age-keygen', '-o', str(wrong_key)], check=True, capture_output=True)
        with self.assertRaises(subprocess.CalledProcessError):
            self.decrypt(database, wrong_key)
        database.write_bytes(database.read_bytes()[:-1])
        with self.assertRaises(subprocess.CalledProcessError):
            self.decrypt(database)

    def test_database_only(self):
        self.env.pop('CLICKSHIELD_REPLAY_VOLUME')
        self.run_script('backup.sh')
        self.assertEqual(len(list(self.backups.glob('*.age'))), 1)
        self.assertNotIn('stop', self.log.read_text())

    def test_invalid_or_missing_recipients_fail_before_docker(self):
        for recipients in (None, '', 'not-an-age-recipient'):
            with self.subTest(recipients=recipients):
                if recipients is None:
                    self.env.pop('CLICKSHIELD_BACKUP_RECIPIENTS_FILE', None)
                else:
                    self.env['CLICKSHIELD_BACKUP_RECIPIENTS_FILE'] = str(self.recipients)
                    self.recipients.write_text(recipients)
                self.run_script('backup.sh', success=False)
                self.assertNotIn('docker', self.log.read_text())
                self.assertFalse(list(self.backups.glob('*.age')))

    def test_failed_producers_and_encryption_restore_worker(self):
        self.mock('age')
        self.mock('mv')
        for failure in ('dump', 'replay', 'encrypt-dump', 'encrypt-replay', 'publish'):
            with self.subTest(failure=failure):
                self.log.write_text('')
                self.env['TEST_FAIL'] = failure
                self.run_script('backup.sh', success=False)
                self.assertFalse(list(self.backups.glob('*.age')))
                self.assertFalse([p for p in self.backups.glob('.backup.*') if p.is_dir()])
                self.assertEqual(self.log.read_text().count('up -d --no-deps worker'), 1)

    def setup_remote(self, encrypted):
        remote = self.root / 'remote'
        remote.mkdir()
        self.env['TEST_REMOTE'] = str(remote)
        suffix = '.age' if encrypted else ''
        names = ['clickshield-20261001T000000Z' + extension + suffix for extension in ('.dump', '.replay.tar.gz')]
        for name in names: (remote / name).write_bytes(b'fixture ' + name.encode())
        return remote, names

    def test_pull_legacy_and_encrypted_pairs(self):
        remote, names = self.setup_remote(False)
        self.run_script('pull_backup.sh')
        for name in names: self.assertEqual((self.backups / name).read_bytes(), (remote / name).read_bytes())
        encrypted = [name.replace('20261001', '20261002') + '.age' for name in names]
        for name in encrypted: (remote / name).write_bytes(b'ciphertext fixture')
        # Repair an existing corrupt local copy rather than getting stuck on it.
        (self.backups / encrypted[0]).write_bytes(b'corrupt')
        old = self.backups / 'clickshield-20000101T000000Z.dump.age'
        old.touch()
        os.utime(old, (0, 0))
        self.run_script('pull_backup.sh')
        for name in encrypted:
            path = self.backups / name
            self.assertEqual(path.read_bytes(), (remote / name).read_bytes())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(old.exists())
        self.assertFalse([p for p in self.backups.glob('.pull.*') if p.is_dir()])

    def test_bad_transfer_does_not_publish_and_retry_works(self):
        remote, names = self.setup_remote(True)
        for failure in ('transfer', 'checksum'):
            with self.subTest(failure=failure):
                self.env['TEST_FAIL'] = failure
                self.run_script('pull_backup.sh', success=False)
                for name in names:
                    self.assertFalse((self.backups / name).exists())
                self.assertFalse([p for p in self.backups.glob('.pull.*') if p.is_dir()])
        self.env.pop('TEST_FAIL')
        self.run_script('pull_backup.sh')
        self.assertEqual((self.backups / names[0]).read_bytes(), (remote / names[0]).read_bytes())


if __name__ == '__main__':
    unittest.main()
