#!/bin/bash
set -euo pipefail

# This script exists to find out if you have vagrant and libvirt set
# up, and to help you do first-time setup tasks so you can run the
# installer tests.

# These two functions are borrowed from install.sh.

error() {
  if [ $# != 0 ]; then
    echo -en '\e[0;31m' >&2
    echo "$@" | (fold -s || cat) >&2
    echo -en '\e[0m' >&2
  fi
}

fail() {
  error "$@"
  exit 1
}

# Look for executable dependencies.
for dep in vagrant pip ; do
    which $dep > /dev/null || fail "Please install $dep(1)."
done

# Check if Vagrant has plugins we need; if not, we install them.
#
# vagrant-libvirt plugin: used to run VMs via qemu.
#
# vagrant-mutate: used to convert VMs into qemu format.
for vgplugin in vagrant-mutate vagrant-libvirt; do
  (vagrant plugin list | grep -q "$vgplugin") || vagrant plugin install "$vgplugin"
done

# Download this particular random Debian Jessie VM and then convert it to
# libvirt format.
(vagrant box list | grep -q thoughtbot_jessie) || vagrant box add thoughtbot_jessie https://vagrantcloud.com/thoughtbot/boxes/debian-jessie-64/versions/0.1.0/providers/virtualbox.box
(vagrant box list | grep -q 'thoughtbot_jessie.*libvirt') || vagrant mutate thoughtbot_jessie libvirt

# Do the same for the main Trusty (Ubuntu 14.04) VM.
(vagrant box list | grep -q 'trusty64') || vagrant box add trusty64 https://cloud-images.ubuntu.com/vagrant/trusty/current/trusty-server-cloudimg-amd64-vagrant-disk1.box
(vagrant box list | grep -q 'trusty64.*libvirt') || vagrant mutate trusty64 libvirt

# Do the same for a 32-bit Debian VM.
(vagrant box list | grep -q 'debian-7.8-32-nocm') || vagrant box add debian-7.8-32-nocm https://vagrantcloud.com/puppetlabs/boxes/debian-7.8-32-nocm/versions/1.0.2/providers/virtualbox.box
(vagrant box list | grep -q 'debian-7.8-32-nocm.*libvirt') || vagrant mutate debian-7.8-32-nocm libvirt

# Do the same for the main Precise (Ubuntu 12.04) VM.
(vagrant box list | grep -q 'precise64') || vagrant box add precise64 https://vagrantcloud.com/hashicorp/boxes/precise64/versions/1.1.0/providers/virtualbox.box
(vagrant box list | grep -q 'precise64.*libvirt') || vagrant mutate precise64 libvirt

# Download the latest released version of Asheesh's stodgy-tester tool, if it is absent.
if [ ! -f ~/.local/bin/stodgy-tester ] ; then
  pip install --user --upgrade git+https://github.com/paulproteus/stodgy-tester.git#egg=stodgy-tester
fi
